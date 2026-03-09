import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';
import {
  QUEUE_AUTONOMY,
  QUEUE_RENDER,
  QUEUE_YOUTUBE_UPLOAD,
} from '../redis/redis.constants';

export interface RenderJobPayload {
  sessionId: string;
  userId: string;
  chatId: string; // ✅ Telegram chat для отправки результата
}

export interface AutonomyPlanDayPayload {
  pipelineKey: string;
  planDate: string;
}

export interface AutonomyRunPayload {
  runId: string;
}

export interface YouTubeUploadPayload {
  sessionId: string;
  runId: string;
  opsChatId: string;
}

@Injectable()
export class QueuesService {
  constructor(
    @InjectQueue(QUEUE_RENDER) private readonly renderQueue: Queue,
    @InjectQueue(QUEUE_AUTONOMY) private readonly autonomyQueue: Queue,
    @InjectQueue(QUEUE_YOUTUBE_UPLOAD)
    private readonly youtubeUploadQueue: Queue,
  ) {}

  private defaultRenderJobOptions(): JobsOptions {
    return {
      removeOnComplete: { age: 60 * 60, count: 5000 },
      removeOnFail: { age: 24 * 60 * 60, count: 5000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    };
  }

  private defaultAutonomyJobOptions(): JobsOptions {
    return {
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 5000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 5000 },
      attempts: 1,
    };
  }

  private defaultYoutubeUploadJobOptions(): JobsOptions {
    return {
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 5000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 5000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5 * 60_000 },
    };
  }

  async enqueueRender(payload: RenderJobPayload) {
    const jobId = payload.sessionId;

    const existing = await this.renderQueue.getJob(jobId);
    if (existing) return existing;

    return this.renderQueue.add('render', payload, {
      ...this.defaultRenderJobOptions(),
      jobId,
    });
  }

  async getRenderJob(sessionId: string) {
    return this.renderQueue.getJob(sessionId);
  }

  async ensureAutonomyRepeatableJobs(pipelineKey: string, timezone: string) {
    await this.autonomyQueue.add(
      'plan-day',
      {
        pipelineKey,
        planDate: '__today__',
      } satisfies AutonomyPlanDayPayload,
      {
        ...this.defaultAutonomyJobOptions(),
        jobId: `autonomy:repeat:plan-day:${pipelineKey}`,
        repeat: {
          pattern: '5 0 * * *',
          tz: timezone,
        },
      },
    );

    await this.autonomyQueue.add(
      'reconcile',
      {
        pipelineKey,
        planDate: '__today__',
      } satisfies AutonomyPlanDayPayload,
      {
        ...this.defaultAutonomyJobOptions(),
        jobId: `autonomy:repeat:reconcile:${pipelineKey}`,
        repeat: {
          pattern: '0 * * * *',
          tz: timezone,
        },
      },
    );
  }

  async enqueueAutonomyPlanDay(payload: AutonomyPlanDayPayload) {
    const jobId = `autonomy:plan-day:${payload.pipelineKey}:${payload.planDate}`;
    const existing = await this.autonomyQueue.getJob(jobId);
    if (existing) return existing;

    return this.autonomyQueue.add('plan-day', payload, {
      ...this.defaultAutonomyJobOptions(),
      jobId,
    });
  }

  async enqueueAutonomyReconcile(pipelineKey: string) {
    const jobId = `autonomy:reconcile:${pipelineKey}`;
    const existing = await this.autonomyQueue.getJob(jobId);
    if (existing) return existing;

    return this.autonomyQueue.add(
      'reconcile',
      {
        pipelineKey,
        planDate: '__today__',
      } satisfies AutonomyPlanDayPayload,
      {
        ...this.defaultAutonomyJobOptions(),
        jobId,
      },
    );
  }

  async scheduleAutonomyRun(payload: AutonomyRunPayload, scheduledAt: Date) {
    const jobId = `autonomy:run:${payload.runId}`;
    const existing = await this.autonomyQueue.getJob(jobId);
    if (existing) return existing;

    const delay = Math.max(0, scheduledAt.getTime() - Date.now());

    return this.autonomyQueue.add('run-slot', payload, {
      ...this.defaultAutonomyJobOptions(),
      jobId,
      delay,
    });
  }

  async enqueueAutonomyRunNow(payload: AutonomyRunPayload) {
    const jobId = `autonomy:run:${payload.runId}:manual`;
    return this.autonomyQueue.add('run-slot', payload, {
      ...this.defaultAutonomyJobOptions(),
      jobId,
    });
  }

  async getAutonomyRunJob(runId: string) {
    return this.autonomyQueue.getJob(`autonomy:run:${runId}`);
  }

  async enqueueYoutubeUpload(payload: YouTubeUploadPayload) {
    const jobId = `youtube-upload:${payload.runId}`;
    const existing = await this.youtubeUploadQueue.getJob(jobId);
    if (existing) return existing;

    return this.youtubeUploadQueue.add('youtube-upload', payload, {
      ...this.defaultYoutubeUploadJobOptions(),
      jobId,
    });
  }
}
