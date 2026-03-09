import { Processor, WorkerHost } from '@nestjs/bullmq';
import { RenderSessionState } from '@prisma/client';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { YouTubeUploadPayload } from '../modules/queues/queues.service';
import { QUEUE_YOUTUBE_UPLOAD } from '../modules/redis/redis.constants';
import { SessionsService } from '../modules/sessions/sessions.service';
import { AutonomyService } from '../modules/autonomy/autonomy.service';
import { YoutubeService } from '../modules/youtube/youtube.service';
import { StorageService } from '../modules/storage/storage.service';
import { TelegramSenderService } from '../modules/telegram-sender/telegram-sender.service';
import { ProgressService } from '../modules/redis/progress.service';
import { clipError, shortYoutubeUrl } from '../modules/autonomy/autonomy.utils';

@Processor(QUEUE_YOUTUBE_UPLOAD, { concurrency: 1 })
export class YouTubeUploadProcessor extends WorkerHost {
  private readonly logger = new Logger(YouTubeUploadProcessor.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly autonomy: AutonomyService,
    private readonly youtube: YoutubeService,
    private readonly storage: StorageService,
    private readonly tg: TelegramSenderService,
    private readonly progress: ProgressService,
  ) {
    super();
  }

  async process(job: Job<YouTubeUploadPayload>): Promise<void> {
    const { sessionId, runId, opsChatId } = job.data;
    const session = await this.sessions.getSessionById(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!session.outputVideoKey) throw new Error('outputVideoKey missing');

    const run = await this.autonomy.getRunById(runId);
    if (!run) throw new Error(`Autonomy run not found: ${runId}`);
    const plan = await this.autonomy.getDayPlanById(run.dayPlanId);
    if (!plan) throw new Error(`Day plan not found for run ${runId}`);
    const pipeline = await this.autonomy.getPipelineById(plan.pipelineId);
    if (!pipeline) throw new Error(`Pipeline not found for run ${runId}`);

    const owner = await this.autonomy.ensureSystemOwner();
    const channel = await this.youtube.ensureSystemChannel(owner.id);
    if (!channel) {
      throw new Error('YouTube channel metadata is not configured');
    }

    const upload = await this.autonomy.getOrCreateYoutubeUploadRecord(
      sessionId,
      runId,
      channel.id,
    );

    const tmpFile = path.join(os.tmpdir(), `${randomUUID()}.mp4`);

    try {
      await this.progress.setStatus(sessionId, {
        state: 'YOUTUBE_UPLOADING',
        updatedAt: new Date().toISOString(),
        message: 'Uploading to YouTube...',
      });

      await this.storage.downloadToFile(session.outputVideoKey, tmpFile);
      const uploaded = await this.youtube.uploadVideo({
        filePath: tmpFile,
        metadata: {
          jokeText:
            session.jokeText ?? run.jokeTextSnapshot ?? 'Chiste del dia',
          jokeSourceUrl: session.jokeSourceUrl ?? null,
          titleSuffix: pipeline.titleSuffix,
          descriptionFooter: pipeline.descriptionFooter,
        },
        visibility: pipeline.youtubeVisibility,
      });

      await this.autonomy.markYoutubeUploadDone(
        runId,
        upload.id,
        uploaded.videoId,
      );
      await this.sessions.setState(sessionId, RenderSessionState.YOUTUBE_DONE);
      await this.progress.setStatus(sessionId, {
        state: 'YOUTUBE_DONE',
        updatedAt: new Date().toISOString(),
        message: 'Uploaded to YouTube',
      });
      await this.progress.setProgress(sessionId, 100);

      await this.tg.sendMessage(
        opsChatId,
        `✅ YouTube upload complete\nRun: ${runId}\n${shortYoutubeUrl(uploaded.videoId)}`,
      );
    } catch (error) {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt) {
        await this.autonomy.markYoutubeUploadFailed(
          runId,
          upload.id,
          clipError(error, 900),
        );
        await this.sessions.setState(
          sessionId,
          RenderSessionState.YOUTUBE_FAILED,
        );
        await this.progress.setLastError(sessionId, clipError(error));
        await this.progress.setStatus(sessionId, {
          state: 'YOUTUBE_FAILED',
          updatedAt: new Date().toISOString(),
          message: clipError(error, 240),
        });
        await this.tg
          .sendMessage(
            opsChatId,
            `❌ YouTube upload failed\nRun: ${runId}\n${clipError(error, 500)}`,
          )
          .catch(() => {});
      }

      throw error;
    } finally {
      await fs.promises.rm(tmpFile, { force: true }).catch(() => {});
    }
  }
}
