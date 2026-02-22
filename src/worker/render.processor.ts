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
  ) {
    super();
    this.logger.log('RenderProcessor initialized');
  }

  async process(job: Job<RenderJobPayload>): Promise<void> {
    const { sessionId } = job.data;
    this.logger.log(`Job received: id=${job.id} session=${sessionId}`);

    const tmpRoot =
      this.config.get<string>('RENDER_TMP_DIR') ||
      path.join(os.tmpdir(), 'renderer');

    const ffmpegPath = this.config.get<string>('FFMPEG_PATH') || 'ffmpeg';

    const outW = Number(this.config.get<string>('OUTPUT_WIDTH', '1080'));
    const outH = Number(this.config.get<string>('OUTPUT_HEIGHT', '1920'));

    const tmpDir = path.join(tmpRoot, sessionId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const inPath = path.join(tmpDir, 'input.mp4');
    const outPath = path.join(tmpDir, 'out.mp4');

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
      await this.progress.setProgress(sessionId, 25);

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
          `${base},drawtext=fontfile='${fontEsc}':` +
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

      const policy = (session as any).originalAudioPolicy as
        | 'KEEP'
        | 'MUTE'
        | undefined;

      const audioArgs = policy === 'MUTE' ? ['-an'] : ['-c:a', 'copy'];

      const res = await execa(
        ffmpegPath,
        [
          '-y',
          '-i',
          inPath,
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          ...audioArgs,
          outPath,
        ],
        { all: true },
      );

      if (res.all) this.logger.debug(res.all);

      await this.progress.setProgress(sessionId, 75);

      const outKey = `outputs/${sessionId}/${randomUUID()}.mp4`;
      await this.storage.uploadFile(outKey, outPath, 'video/mp4');
      await this.sessions.setOutputVideoKey(sessionId, outKey);

      await this.progress.setProgress(sessionId, 90);

      const url = await this.storage.presignGetUrl(outKey);

      try {
        await this.sendVideoToTelegram(
          job.data.chatId,
          outPath,
          '✅ Render done',
        );
        await this.progress.setStatus(sessionId, {
          state: 'RENDER_DONE',
          updatedAt: new Date().toISOString(),
          message: 'Done. Sent as video.',
        });
      } catch {
        await this.progress.setStatus(sessionId, {
          state: 'RENDER_DONE',
          updatedAt: new Date().toISOString(),
          message: `Done. Link: ${url}`,
        });
      }

      await this.progress.setProgress(sessionId, 100);
    } catch (e: any) {
      const msg = e?.message || String(e);
      await this.progress.setLastError(sessionId, msg);
      await this.progress.setStatus(sessionId, {
        state: 'RENDER_FAILED',
        updatedAt: new Date().toISOString(),
        message: msg,
      });
      this.logger.error(`Render failed session=${sessionId}: ${msg}`, e?.stack);
      throw e;
    }
  }

  private async sendVideoToTelegram(
    chatId: string,
    filePath: string,
    caption?: string,
  ) {
    const apiBase = (
      this.config.get<string>('TELEGRAM_API_BASE_URL') ||
      'https://api.telegram.org'
    ).replace(/\/$/, '');
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');

    const url = `${apiBase}/bot${token}/sendVideo`;

    const buf = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption);
    form.set('video', new Blob([buf]), 'out.mp4');

    const res = await fetch(url, { method: 'POST', body: form as any });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `sendVideo failed: ${res.status} ${res.statusText} ${body}`.slice(
          0,
          500,
        ),
      );
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
