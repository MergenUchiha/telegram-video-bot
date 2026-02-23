import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';

import { QUEUE_RENDER } from '../modules/redis/redis.constants';
import { SessionsService } from '../modules/sessions/sessions.service';
import { StorageService } from '../modules/storage/storage.service';
import { ProgressService } from '../modules/redis/progress.service';
import { TelegramSenderService } from '../modules/telegram-sender/telegram-sender.service';
import { TtsService } from '../modules/tts/tts.service';
import { MediaProbeService } from '../modules/media-probe/media-probe.service';
import { SubtitlesService } from '../modules/subtitles/subtitles.service';

type RenderJobPayload = { sessionId: string; userId: string; chatId: string };

@Processor(QUEUE_RENDER, { concurrency: 1 })
export class RenderProcessor extends WorkerHost {
  private readonly logger = new Logger('RenderProcessor');

  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly progress: ProgressService,
    private readonly config: ConfigService,
    private readonly tg: TelegramSenderService,
    private readonly tts: TtsService,
    private readonly probe: MediaProbeService,
    private readonly subs: SubtitlesService,
  ) {
    super();
    this.logger.log('RenderProcessor initialized');
  }

  async process(job: Job<RenderJobPayload>): Promise<void> {
    const { sessionId, chatId } = job.data;

    const tmpRoot =
      this.config.get<string>('RENDER_TMP_DIR') ||
      path.join(os.tmpdir(), 'renderer');

    const ffmpegPath = this.config.get<string>('FFMPEG_PATH') || 'ffmpeg';
    const outW = Number(this.config.get<string>('OUTPUT_WIDTH', '1080'));
    const outH = Number(this.config.get<string>('OUTPUT_HEIGHT', '1920'));

    const renderTimeoutMs = Number(
      this.config.get<string>('RENDER_TIMEOUT_MS') || '1200000',
    ); // 20m default
    const duckDb = Number(this.config.get<string>('DEFAULT_DUCK_DB') || '-18');

    const tmpDir = path.join(tmpRoot, sessionId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const inPath = path.join(tmpDir, 'input.mp4');
    const outPath = path.join(tmpDir, 'out.mp4');

    const ttsWav = path.join(tmpDir, 'tts.wav');
    const ttsNormWav = path.join(tmpDir, 'tts_norm.wav');

    const srtPath = path.join(tmpDir, 'subs.srt');
    const assPath = path.join(tmpDir, 'subs.ass');

    const clip = (s: any, max = 1800) => {
      const str = String(s ?? '');
      if (str.length <= max) return str;
      return `…(truncated, last ${max} chars)\n${str.slice(-max)}`;
    };

    try {
      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'Worker picked up job',
      });
      await this.progress.setProgress(sessionId, 5);

      const session = await this.sessions.getSessionById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (!session.sourceVideoKey) throw new Error('sourceVideoKey missing');

      await this.storage.downloadToFile(session.sourceVideoKey, inPath);
      await this.progress.setProgress(sessionId, 15);

      const meta = await this.probe.probe(inPath);
      const fps = meta.fps || 30;
      const hasAudio = meta.hasAudio;

      await this.progress.setProgress(sessionId, 20);

      // --- VIDEO FILTER (base + optional overlay + optional hard subs)
      const base = `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`;
      let vf = base;

      const overlayEnabled = (session as any).overlayEnabled;
      const overlayComment = (session as any).overlayComment as string | null;

      if (overlayEnabled && overlayComment) {
        const fontPath = this.config.get<string>(
          'FONT_PATH',
          'C:\\Windows\\Fonts\\arial.ttf',
        );

        const wrapped = this.wrapText(overlayComment.toUpperCase(), 26, 3);

        const escaped = wrapped
          .replace(/\\/g, '\\\\')
          .replace(/\n/g, '\\n')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'");

        const fontEsc = fontPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

        vf =
          `${vf},drawtext=fontfile='${fontEsc}':` +
          `text='${escaped}':` +
          `fontcolor=black:` +
          `fontsize=86:` +
          `line_spacing=18:` +
          `box=1:` +
          `boxcolor=white@0.85:` +
          `boxborderw=40:` +
          `shadowcolor=black@0.25:` +
          `shadowx=2:` +
          `shadowy=2:` +
          `x=(w-text_w)/2:` +
          `y=h-520`;
      }

      // --- TTS + SUBS
      const ttsEnabled = Boolean((session as any).ttsEnabled);
      const ttsText = ((session as any).ttsText as string | null)?.trim() || '';
      const subtitlesMode =
        ((session as any).subtitlesMode as 'NONE' | 'HARD' | 'SOFT') ?? 'NONE';

      if (ttsEnabled) {
        if (!ttsText) throw new Error('TTS enabled but ttsText is empty');

        await this.progress.setStatus(sessionId, {
          state: 'RENDERING',
          updatedAt: new Date().toISOString(),
          message: 'Generating TTS...',
        });

        await this.tts.synthesizeToWav(ttsWav, {
          text: ttsText,
          language: (session as any).language ?? null,
          voiceId: (session as any).voiceId ?? null,
          speed: (session as any).ttsSpeed ?? null,
        });

        await this.progress.setProgress(sessionId, 35);

        // loudnorm
        await this.runFfmpeg(
          ffmpegPath,
          [
            '-y',
            '-i',
            ttsWav,
            '-af',
            'loudnorm=I=-16:LRA=11:TP=-1.5',
            ttsNormWav,
          ],
          renderTimeoutMs,
        );

        await this.progress.setProgress(sessionId, 45);

        if (subtitlesMode === 'HARD') {
          await this.progress.setStatus(sessionId, {
            state: 'RENDERING',
            updatedAt: new Date().toISOString(),
            message: 'Generating subtitles...',
          });

          // MVP: тайминги по длительности входного видео (можно по tts длительности позже)
          await this.subs.makeSrt(srtPath, ttsText, meta.durationSec || 10);
          await this.subs.srtToAss(assPath, srtPath);

          const assEsc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
          vf = `${vf},ass='${assEsc}'`;

          await this.progress.setProgress(sessionId, 55);
        }
      }

      // --- AUDIO POLICY
      const policy =
        ((session as any).originalAudioPolicy as
          | 'REPLACE'
          | 'DUCK'
          | 'MUTE'
          | 'KEEP') ?? 'KEEP';
      const advancedKeepWithTts = Boolean((session as any).advancedKeepWithTts);

      // ✅ ВАЖНО: сперва все -i, потом фильтры
      const inputs: string[] = ['-y', '-i', inPath];
      const useTtsAudio = ttsEnabled;

      if (useTtsAudio) {
        inputs.push('-i', ttsNormWav);
      }

      // видео-настройки (после инпутов!)
      const videoArgs: string[] = [
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-r',
        String(Math.round(fps * 1000) / 1000),
      ];

      const outArgs: string[] = [];

      if (!useTtsAudio) {
        // no TTS: KEEP/MUTE only
        if (!hasAudio || policy === 'MUTE') {
          outArgs.push('-an');
        } else {
          // можно copy, можно aac — оставим copy как было
          outArgs.push('-c:a', 'copy');
        }
        outArgs.push(outPath);

        await this.progress.setProgress(sessionId, 70);
        await this.runFfmpeg(
          ffmpegPath,
          [...inputs, ...videoArgs, ...outArgs],
          renderTimeoutMs,
        );
      } else {
        // with TTS
        // if no original audio — DUCK/KEEP behave like REPLACE
        const effectivePolicy = hasAudio
          ? policy
          : policy === 'KEEP'
            ? 'REPLACE'
            : policy === 'DUCK'
              ? 'REPLACE'
              : policy;

        if (effectivePolicy === 'REPLACE' || effectivePolicy === 'MUTE') {
          // only TTS audio
          outArgs.push(
            '-map',
            '0:v:0',
            '-map',
            '1:a:0',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            outPath,
          );

          await this.progress.setProgress(sessionId, 70);
          await this.runFfmpeg(
            ffmpegPath,
            [...inputs, ...videoArgs, ...outArgs],
            renderTimeoutMs,
          );
        } else if (effectivePolicy === 'DUCK') {
          // duck original + mix with tts
          const duck = Number.isFinite(duckDb) ? duckDb : -18;

          outArgs.push(
            '-filter_complex',
            `[0:a]volume=${duck}dB[a0];[a0][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`,
            '-map',
            '0:v:0',
            '-map',
            '[a]',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            outPath,
          );

          await this.progress.setProgress(sessionId, 70);
          await this.runFfmpeg(
            ffmpegPath,
            [...inputs, ...videoArgs, ...outArgs],
            renderTimeoutMs,
          );
        } else {
          // KEEP with TTS:
          if (!advancedKeepWithTts) {
            outArgs.push(
              '-map',
              '0:v:0',
              '-map',
              '0:a:0',
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              outPath,
            );

            await this.progress.setProgress(sessionId, 70);
            await this.runFfmpeg(
              ffmpegPath,
              [...inputs, ...videoArgs, ...outArgs],
              renderTimeoutMs,
            );
          } else {
            // advanced: mix without duck
            outArgs.push(
              '-filter_complex',
              `[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`,
              '-map',
              '0:v:0',
              '-map',
              '[a]',
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              outPath,
            );

            await this.progress.setProgress(sessionId, 70);
            await this.runFfmpeg(
              ffmpegPath,
              [...inputs, ...videoArgs, ...outArgs],
              renderTimeoutMs,
            );
          }
        }
      }

      await this.progress.setProgress(sessionId, 80);

      const outKey = `outputs/${sessionId}/${randomUUID()}.mp4`;
      await this.storage.uploadFile(outKey, outPath, 'video/mp4');
      await this.sessions.setOutputVideoKey(sessionId, outKey);

      await this.progress.setProgress(sessionId, 90);

      const url = await this.storage.presignGetUrl(outKey);

      try {
        await this.tg.sendVideoFile(chatId, outPath, '✅ Render done');
        await this.progress.setStatus(sessionId, {
          state: 'RENDER_DONE',
          updatedAt: new Date().toISOString(),
          message: 'Done. Sent as video.',
        });
      } catch {
        await this.tg.sendVideoByUrl(chatId, url, '✅ Render done (link)');
        await this.progress.setStatus(sessionId, {
          state: 'RENDER_DONE',
          updatedAt: new Date().toISOString(),
          message: `Done. Link sent.`,
        });
      }

      await this.progress.setProgress(sessionId, 100);
    } catch (e: any) {
      const msg = clip(e?.message || String(e), 1600);

      await this.progress.setLastError(sessionId, msg);
      await this.progress.setStatus(sessionId, {
        state: 'RENDER_FAILED',
        updatedAt: new Date().toISOString(),
        message: msg,
      });

      throw e;
    } finally {
      // tmp cleanup
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  private async runFfmpeg(
    ffmpegPath: string,
    args: string[],
    timeoutMs: number,
  ) {
    try {
      const res = await execa(ffmpegPath, args, {
        all: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      if (res.all) this.logger.debug(res.all);
    } catch (e: any) {
      // execa кидает исключение, но там часто есть e.all (stdout+stderr)
      const all = e?.all ? String(e.all) : '';
      const baseMsg = e?.message || String(e);

      const clip = (s: string, max = 2400) =>
        s.length <= max
          ? s
          : `…(truncated, last ${max} chars)\n${s.slice(-max)}`;

      const merged =
        all && all.trim().length
          ? `${baseMsg}\n\nffmpeg output:\n${clip(all, 2400)}`
          : baseMsg;

      this.logger.error(clip(merged, 2400));
      // пробрасываем дальше — это увидит верхний catch и сохранит в Redis
      throw new Error(clip(merged, 2400));
    }
  }

  private wrapText(text: string, maxLineLen = 26, maxLines = 3) {
    const words = text.trim().split(/\s+/);
    const lines: string[] = [];
    let line = '';

    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length <= maxLineLen) {
        line = next;
      } else {
        if (line) lines.push(line);
        line = w;
        if (lines.length >= maxLines - 1) break;
      }
    }

    if (line && lines.length < maxLines) lines.push(line);

    const usedWords = lines.join(' ').split(/\s+/).length;
    if (usedWords < words.length) {
      lines[lines.length - 1] =
        `${lines[lines.length - 1].replace(/\.*$/, '')}…`;
    }

    return lines.join('\n');
  }
}
