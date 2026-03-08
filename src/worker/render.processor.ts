import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RenderSessionState } from '@prisma/client';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';

import { QUEUE_RENDER } from '../modules/redis/redis.constants';
import { SessionsService } from '../modules/sessions/sessions.service';
import { StorageService } from '../modules/storage/storage.service';
import { ProgressService } from '../modules/redis/progress.service';
import { LockService } from '../modules/redis/lock.service';
import { TelegramSenderService } from '../modules/telegram-sender/telegram-sender.service';
import { TtsService } from '../modules/tts/tts.service';
import { MediaProbeService } from '../modules/media-probe/media-probe.service';
import { SubtitlesService } from '../modules/subtitles/subtitles.service';
import { MetricsService } from '../modules/metrics/metrics.service';

type RenderJobPayload = { sessionId: string; userId: string; chatId: string };

@Processor(QUEUE_RENDER, { concurrency: 1 })
export class RenderProcessor extends WorkerHost {
  private readonly logger = new Logger('RenderProcessor');

  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly progress: ProgressService,
    private readonly lock: LockService,
    private readonly config: ConfigService,
    private readonly tg: TelegramSenderService,
    private readonly tts: TtsService,
    private readonly probe: MediaProbeService,
    private readonly subs: SubtitlesService,
    private readonly metrics: MetricsService,
  ) {
    super();
    this.logger.log('RenderProcessor initialized');
  }

  async process(job: Job<RenderJobPayload>): Promise<void> {
    const { sessionId, userId, chatId } = job.data;
    const startedAt = new Date();

    const tmpRoot =
      this.config.get<string>('RENDER_TMP_DIR') ||
      path.join(os.tmpdir(), 'renderer');
    const ffmpegPath = this.config.get<string>('FFMPEG_PATH') || 'ffmpeg';
    const outW = Number(this.config.get<string>('OUTPUT_WIDTH', '1080'));
    const outH = Number(this.config.get<string>('OUTPUT_HEIGHT', '1920'));
    const renderTimeoutMs = Number(
      this.config.get<string>('RENDER_TIMEOUT_MS') || '1200000',
    );
    const configDuckDb = Number(
      this.config.get<string>('DEFAULT_DUCK_DB') || '-18',
    );

    const tmpDir = path.join(tmpRoot, sessionId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const inPath = path.join(tmpDir, 'input.mp4');
    const outPath = path.join(tmpDir, 'out.mp4');
    const ttsWav = path.join(tmpDir, 'tts.wav');
    const ttsNormWav = path.join(tmpDir, 'tts_norm.wav');
    const srtPath = path.join(tmpDir, 'subs.srt');
    const assPath = path.join(tmpDir, 'subs.ass');
    const overlayTextFile = path.join(tmpDir, 'overlay.txt');

    const clip = (s: any, max = 1800) => {
      const str = String(s ?? '');
      return str.length <= max ? str : `…(truncated)\n${str.slice(-max)}`;
    };

    // ── Distributed lock — защита при горизонтальном масштабировании ─────────
    // При нескольких репликах воркера BullMQ гарантирует доставку задачи
    // только одному воркеру, но лок даёт дополнительную защиту на случай
    // edge-case'ов при race condition на старте/рестарте.
    const lockResult = await this.lock.acquireUserRenderLock(userId, sessionId);
    if (!lockResult.ok) {
      this.logger.warn(
        `Lock busy for user ${userId}, session ${sessionId} — skipping`,
      );
      return; // Не бросаем, не ретраим — задача уже обрабатывается другим воркером
    }
    const lockKey = lockResult.key;

    // Продлеваем лок каждую минуту пока рендер идёт
    const lockRefreshInterval = setInterval(async () => {
      const ok = await this.lock.refreshLock(lockKey, sessionId);
      if (!ok)
        this.logger.warn(`Lock lost mid-render for session ${sessionId}`);
    }, 60_000);

    try {
      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'Воркер принял задачу',
      });
      await this.progress.setProgress(sessionId, 5);

      const session = await this.sessions.getSessionById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (!session.sourceVideoKey) throw new Error('sourceVideoKey missing');

      const duckDb =
        typeof (session as any).customDuckDb === 'number'
          ? (session as any).customDuckDb
          : configDuckDb;

      await this.storage.downloadToFile(session.sourceVideoKey, inPath);
      await this.progress.setProgress(sessionId, 15);

      const meta = await this.probe.probe(inPath);
      const fps = meta.fps || 30;
      const hasAudio = meta.hasAudio;

      await this.progress.setProgress(sessionId, 20);

      // ── VIDEO FILTER ──────────────────────────────────────────────────────
      const base = `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`;
      let vf = base;

      const overlayEnabled = Boolean((session as any).overlayEnabled);
      const overlayComment = (session as any).overlayComment as string | null;

      if (overlayEnabled && overlayComment) {
        const fontPath = this.config.get<string>(
          'FONT_PATH',
          'C:\\Windows\\Fonts\\arial.ttf',
        );
        const wrapped = this.wrapText(overlayComment.toUpperCase(), 22);

        // textfile= вместо text= — реальные \n из файла, никакого escaping
        await fs.promises.writeFile(overlayTextFile, wrapped, 'utf-8');
        const fontEsc = fontPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
        const textFileEsc = overlayTextFile
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:');

        vf =
          `${vf},drawtext=fontfile='${fontEsc}':` +
          `textfile='${textFileEsc}':` +
          `fontcolor=black:fontsize=72:line_spacing=14:` +
          `box=1:boxcolor=white@0.85:boxborderw=36:` +
          `shadowcolor=black@0.25:shadowx=2:shadowy=2:` +
          `x=(w-text_w)/2:y=h-text_h-160`;
      }

      // ── TTS + SUBS ────────────────────────────────────────────────────────
      const ttsEnabled = Boolean((session as any).ttsEnabled);
      const ttsText = ((session as any).ttsText as string | null)?.trim() || '';
      const subtitlesMode =
        ((session as any).subtitlesMode as 'NONE' | 'HARD' | 'SOFT') ?? 'NONE';

      if (ttsEnabled) {
        if (!ttsText) throw new Error('TTS включён, но ttsText пуст');

        await this.progress.setStatus(sessionId, {
          state: 'RENDERING',
          updatedAt: new Date().toISOString(),
          message: 'Генерирую TTS...',
        });

        await this.tts.synthesizeToWav(ttsWav, {
          text: ttsText,
          language: (session as any).language ?? null,
          voiceId: (session as any).voiceId ?? null,
          speed: (session as any).ttsSpeed ?? null,
        });

        await this.progress.setProgress(sessionId, 35);
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
            message: 'Генерирую субтитры...',
          });
          await this.subs.makeSrt(srtPath, ttsText, meta.durationSec || 10);
          await this.subs.srtToAss(assPath, srtPath);
          const assEsc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
          vf = `${vf},ass='${assEsc}'`;
          await this.progress.setProgress(sessionId, 55);
        }
      }

      // ── AUDIO POLICY ─────────────────────────────────────────────────────
      const policy =
        ((session as any).originalAudioPolicy as
          | 'REPLACE'
          | 'DUCK'
          | 'MUTE'
          | 'KEEP') ?? 'KEEP';
      const advancedKeepWithTts = Boolean((session as any).advancedKeepWithTts);

      const inputs: string[] = ['-y', '-i', inPath];
      if (ttsEnabled) inputs.push('-i', ttsNormWav);

      const videoArgs = [
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

      if (!ttsEnabled) {
        outArgs.push(
          ...(!hasAudio || policy === 'MUTE' ? ['-an'] : ['-c:a', 'copy']),
          outPath,
        );
      } else {
        const eff = hasAudio
          ? policy
          : policy === 'KEEP' || policy === 'DUCK'
            ? 'REPLACE'
            : policy;
        if (eff === 'REPLACE' || eff === 'MUTE') {
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
        } else if (eff === 'DUCK') {
          outArgs.push(
            '-filter_complex',
            `[0:a]volume=${duckDb}dB[a0];[a0][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`,
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
        } else {
          // KEEP
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
          } else {
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
          }
        }
      }

      await this.progress.setProgress(sessionId, 70);
      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'FFmpeg обрабатывает...',
      });

      await this.runFfmpeg(
        ffmpegPath,
        [...inputs, ...videoArgs, ...outArgs],
        renderTimeoutMs,
      );
      await this.progress.setProgress(sessionId, 80);

      const outKey = `outputs/${sessionId}/${randomUUID()}.mp4`;
      await this.storage.uploadFile(outKey, outPath, 'video/mp4');
      await this.sessions.setOutputVideoKey(sessionId, outKey);
      await this.progress.setProgress(sessionId, 90);

      const url = await this.storage.presignGetUrl(outKey);
      try {
        await this.tg.sendVideoFile(chatId, outPath, '✅ Рендер завершён!');
      } catch {
        await this.tg.sendVideoByUrl(
          chatId,
          url,
          '✅ Рендер завершён! (ссылка)',
        );
      }

      await this.sessions.setState(sessionId, RenderSessionState.RENDER_DONE);
      await this.progress.setStatus(sessionId, {
        state: 'RENDER_DONE',
        updatedAt: new Date().toISOString(),
        message: 'Готово',
      });
      await this.progress.setProgress(sessionId, 100);

      // ── Метрики ───────────────────────────────────────────────────────────
      const finishedAt = new Date();
      await this.metrics
        .recordJobDone({
          sessionId,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        })
        .catch(() => {});
    } catch (e: any) {
      const msg = clip(e?.message || String(e), 1600);
      const finishedAt = new Date();

      await this.progress.setLastError(sessionId, msg);
      await this.progress.setStatus(sessionId, {
        state: 'RENDER_FAILED',
        updatedAt: new Date().toISOString(),
        message: msg,
      });
      try {
        await this.sessions.setState(
          sessionId,
          RenderSessionState.RENDER_FAILED,
        );
      } catch {}

      await this.metrics
        .recordJobFailed({
          sessionId,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          error: msg.slice(0, 500),
        })
        .catch(() => {});

      await this.tg
        .sendMessage(
          chatId,
          `❌ Рендер завершился с ошибкой:\n${msg.slice(0, 1000)}`,
        )
        .catch(() => {});

      throw e;
    } finally {
      clearInterval(lockRefreshInterval);
      await this.lock.releaseLock(lockKey, sessionId).catch(() => {});
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
      const all = e?.all ? String(e.all) : '';
      const clip = (s: string, max = 2400) =>
        s.length <= max ? s : `…\n${s.slice(-max)}`;
      const merged = all?.trim()
        ? `${e?.message}\n\nffmpeg output:\n${clip(all, 2400)}`
        : String(e?.message);
      this.logger.error(clip(merged, 2400));
      throw new Error(clip(merged, 2400));
    }
  }

  private wrapText(text: string, maxLineLen = 22): string {
    const words = text.trim().split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (candidate.length <= maxLineLen) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        if (w.length > maxLineLen) {
          let rest = w;
          while (rest.length > maxLineLen) {
            lines.push(rest.slice(0, maxLineLen));
            rest = rest.slice(maxLineLen);
          }
          line = rest;
        } else {
          line = w;
        }
      }
    }
    if (line) lines.push(line);
    return lines.join('\n');
  }
}
