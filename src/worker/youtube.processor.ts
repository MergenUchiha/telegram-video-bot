import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { RenderSessionState } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { QUEUE_YOUTUBE } from '../modules/redis/redis.constants';
import { SessionsService } from '../modules/sessions/sessions.service';
import { StorageService } from '../modules/storage/storage.service';
import { ProgressService } from '../modules/redis/progress.service';
import { TelegramSenderService } from '../modules/telegram-sender/telegram-sender.service';
import { YouTubeService } from '../modules/youtube/youtube.service';
import type {
  YouTubeUploadPayload,
  YouTubeVideoMeta,
} from '../modules/youtube/youtube.types';

@Processor(QUEUE_YOUTUBE, { concurrency: 1 })
export class YouTubeProcessor extends WorkerHost {
  private readonly logger = new Logger('YouTubeProcessor');

  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly progress: ProgressService,
    private readonly tg: TelegramSenderService,
    private readonly youtube: YouTubeService,
  ) {
    super();
    this.logger.log('YouTubeProcessor initialized');
  }

  async process(job: Job<YouTubeUploadPayload>): Promise<void> {
    const { sessionId, channelId, chatId } = job.data;

    const tmpDir = path.join(
      process.env['RENDER_TMP_DIR'] ?? path.join(os.tmpdir(), 'renderer'),
      `yt-${sessionId}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });

    let uploadRecord: { id: string } | null = null;

    try {
      // 1. Создаём запись загрузки и обновляем статус сессии
      uploadRecord = await this.youtube.createUploadRecord(
        sessionId,
        channelId,
      );

      await this.sessions.setState(
        sessionId,
        RenderSessionState.YOUTUBE_UPLOADING,
      );
      await this.progress.setStatus(sessionId, {
        state: 'YOUTUBE_UPLOADING',
        updatedAt: new Date().toISOString(),
        message: 'Загрузка на YouTube...',
      });

      await this.youtube.updateUploadRecord(uploadRecord.id, {
        status: 'UPLOADING',
        startedAt: new Date(),
      });

      // 2. Загружаем видео из S3 во временный файл
      const session = await this.sessions.getSessionById(sessionId);
      if (!session?.outputVideoKey) {
        throw new Error('Нет выходного видео для загрузки на YouTube');
      }

      const localPath = path.join(tmpDir, 'upload.mp4');
      await this.storage.downloadToFile(session.outputVideoKey, localPath);

      // 3. Формируем метаданные видео
      const meta = this.buildVideoMeta(session);

      // 4. Загружаем на YouTube
      const videoId = await this.youtube.uploadVideo(
        channelId,
        localPath,
        meta,
      );

      // 5. Обновляем записи
      await this.youtube.updateUploadRecord(uploadRecord.id, {
        status: 'DONE',
        youtubeVideoId: videoId,
        finishedAt: new Date(),
      });

      await this.sessions.setState(sessionId, RenderSessionState.YOUTUBE_DONE);
      await this.progress.setStatus(sessionId, {
        state: 'YOUTUBE_DONE',
        updatedAt: new Date().toISOString(),
        message: 'Видео загружено на YouTube',
      });

      // 6. Уведомляем пользователя
      const link = `https://youtu.be/${videoId}`;
      await this.tg
        .sendMessage(chatId, `✅ Видео загружено на YouTube!\n🔗 ${link}`)
        .catch(() => {});

      this.logger.log(`[${sessionId}] YouTube upload complete: ${link}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`[${sessionId}] YouTube upload failed: ${msg}`);

      if (uploadRecord) {
        await this.youtube
          .updateUploadRecord(uploadRecord.id, {
            status: 'FAILED',
            error: msg.slice(0, 1000),
            finishedAt: new Date(),
          })
          .catch(() => {});
      }

      await this.sessions
        .setState(sessionId, RenderSessionState.YOUTUBE_FAILED)
        .catch(() => {});

      await this.progress
        .setStatus(sessionId, {
          state: 'YOUTUBE_FAILED',
          updatedAt: new Date().toISOString(),
          message: msg.slice(0, 300),
        })
        .catch(() => {});

      await this.tg
        .sendMessage(
          chatId,
          `❌ Ошибка загрузки на YouTube:\n${msg.slice(0, 500)}`,
        )
        .catch(() => {});

      throw e;
    } finally {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private buildVideoMeta(session: any): YouTubeVideoMeta {
    const isJokes = session.contentMode === 'SPANISH_JOKES_AUTO';

    let title: string;
    let description: string;
    let tags: string[];

    if (isJokes && session.jokeText) {
      // Для анекдотов — название из текста анекдота
      const jokePreview = session.jokeText.slice(0, 80).replace(/\n/g, ' ');
      title = `${jokePreview}${session.jokeText.length > 80 ? '…' : ''}`;
      description = [
        session.jokeText,
        '',
        '#chistes #humor #jokes #shorts',
      ].join('\n');
      tags = ['chistes', 'humor', 'jokes', 'shorts', 'funny', 'comedy'];
    } else {
      // Для стандартного рендера
      title = `Video ${new Date().toISOString().slice(0, 10)}`;
      description = 'Rendered video';
      tags = ['video', 'render'];
    }

    return {
      title,
      description,
      tags,
      privacyStatus: 'public',
    };
  }
}
