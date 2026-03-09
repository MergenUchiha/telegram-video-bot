import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ContentMode, RenderSessionState } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { QUEUE_RENDER } from '../modules/redis/redis.constants';
import { SessionsService } from '../modules/sessions/sessions.service';
import { StorageService } from '../modules/storage/storage.service';
import { ProgressService } from '../modules/redis/progress.service';
import { LockService } from '../modules/redis/lock.service';
import { TelegramSenderService } from '../modules/telegram-sender/telegram-sender.service';
import { MetricsService } from '../modules/metrics/metrics.service';
import { UsedJokesService } from '../modules/jokes/used-jokes.service';
import { FfmpegService } from './services/ffmpeg.service';
import { StandardRenderService } from './services/standard-render.service';
import { JokesRenderService } from './services/jokes-render.service';

export interface RenderJobPayload {
  sessionId: string;
  userId: string;
  chatId: string;
}

@Processor(QUEUE_RENDER, { concurrency: 1 })
export class RenderProcessor extends WorkerHost {
  private readonly logger = new Logger('RenderProcessor');

  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly progress: ProgressService,
    private readonly lock: LockService,
    private readonly tg: TelegramSenderService,
    private readonly metrics: MetricsService,
    private readonly usedJokes: UsedJokesService,
    private readonly ffmpeg: FfmpegService,
    private readonly standardRender: StandardRenderService,
    private readonly jokesRender: JokesRenderService,
  ) {
    super();
    this.logger.log('RenderProcessor initialized');
  }

  async process(job: Job<RenderJobPayload>): Promise<void> {
    const { sessionId, userId, chatId } = job.data;
    const startedAt = new Date();

    const tmpDir = path.join(
      process.env['RENDER_TMP_DIR'] ?? path.join(os.tmpdir(), 'renderer'),
      sessionId,
    );
    fs.mkdirSync(tmpDir, { recursive: true });

    const lockResult = await this.lock.acquireUserRenderLock(userId, sessionId);
    if (!lockResult.ok) {
      this.logger.warn(
        `Lock busy for user ${userId}, session ${sessionId} — skipping`,
      );
      return;
    }

    const lockRefreshInterval = setInterval(async () => {
      const ok = await this.lock.refreshLock(lockResult.key, sessionId);
      if (!ok)
        this.logger.warn(`Lock lost mid-render for session ${sessionId}`);
    }, 60_000);

    try {
      await this.setStatus(sessionId, 5, 'Воркер принял задачу');

      const session = await this.sessions.getSessionById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      let outputPath: string;

      if (session.contentMode === ContentMode.SPANISH_JOKES_AUTO) {
        const result = await this.jokesRender.render({
          session,
          userId,
          tmpDir,
        });
        outputPath = result.outputPath;

        // Помечаем анекдот использованным только после успешного рендера
        await this.usedJokes
          .markUsed(userId, result.jokeText)
          .catch((e: Error) =>
            this.logger.warn(`[${sessionId}] markUsed failed: ${e.message}`),
          );

        if (session.autoPublishYoutube) {
          await this.notifyYoutubeAutoPublish(chatId);
        }
      } else {
        outputPath = await this.standardRender.render({ session, tmpDir });
      }

      await this.finalizeAndSend(sessionId, chatId, outputPath, startedAt);
    } catch (e: unknown) {
      await this.handleFailure(e, sessionId, chatId, startedAt);
      throw e;
    } finally {
      clearInterval(lockRefreshInterval);
      await this.lock.releaseLock(lockResult.key, sessionId).catch(() => {});
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async finalizeAndSend(
    sessionId: string,
    chatId: string,
    outputPath: string,
    startedAt: Date,
  ): Promise<void> {
    const outKey = `outputs/${sessionId}/${randomUUID()}.mp4`;
    await this.storage.uploadFile(outKey, outputPath, 'video/mp4');
    await this.sessions.setOutputVideoKey(sessionId, outKey);
    await this.progress.setProgress(sessionId, 90);

    // Сначала пытаемся отправить файл напрямую, при ошибке — по ссылке
    try {
      await this.tg.sendVideoFile(chatId, outputPath, '✅ Рендер завершён!');
    } catch {
      const url = await this.storage.presignGetUrl(outKey);
      await this.tg.sendVideoByUrl(chatId, url, '✅ Рендер завершён! (ссылка)');
    }

    await this.sessions.setState(sessionId, RenderSessionState.RENDER_DONE);
    await this.setStatus(sessionId, 100, 'Готово', 'RENDER_DONE');

    const finishedAt = new Date();
    await this.metrics
      .recordJobDone({
        sessionId,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      })
      .catch(() => {});
  }

  private async handleFailure(
    e: unknown,
    sessionId: string,
    chatId: string,
    startedAt: Date,
  ): Promise<void> {
    const msg = this.ffmpeg.clip(
      e instanceof Error ? e.message : String(e),
      1600,
    );
    const finishedAt = new Date();

    await this.progress.setLastError(sessionId, msg);
    await this.setStatus(sessionId, undefined, msg, 'RENDER_FAILED');

    await this.sessions
      .setState(sessionId, RenderSessionState.RENDER_FAILED)
      .catch(() => {});

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
  }

  private async setStatus(
    sessionId: string,
    progress?: number,
    message?: string,
    state: string = 'RENDERING',
  ): Promise<void> {
    await this.progress.setStatus(sessionId, {
      state: state as any,
      updatedAt: new Date().toISOString(),
      message,
    });
    if (progress !== undefined) {
      await this.progress.setProgress(sessionId, progress);
    }
  }

  private async notifyYoutubeAutoPublish(chatId: string): Promise<void> {
    await this.tg
      .sendMessage(
        chatId,
        '📺 Автопубликация на YouTube будет реализована в следующем обновлении.',
      )
      .catch(() => {});
  }
}
