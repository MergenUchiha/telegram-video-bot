import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';
import { QUEUE_RENDER, QUEUE_YOUTUBE } from '../redis/redis.constants';
import type { RenderJobPayload } from '../../common/types/render-job.types';
import type { YouTubeUploadPayload } from '../youtube/youtube.types';

export type { RenderJobPayload, YouTubeUploadPayload };

@Injectable()
export class QueuesService {
  constructor(
    @InjectQueue(QUEUE_RENDER) private readonly renderQueue: Queue,
    @InjectQueue(QUEUE_YOUTUBE) private readonly youtubeQueue: Queue,
  ) {}

  private defaultJobOptions(): JobsOptions {
    return {
      removeOnComplete: { age: 60 * 60, count: 5000 },
      removeOnFail: { age: 24 * 60 * 60, count: 5000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    };
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  async enqueueRender(payload: RenderJobPayload) {
    const jobId = payload.sessionId;

    const existing = await this.renderQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') {
        await existing.remove();
      } else {
        return existing;
      }
    }

    return this.renderQueue.add('render', payload, {
      ...this.defaultJobOptions(),
      jobId,
    });
  }

  async getRenderJob(sessionId: string) {
    return this.renderQueue.getJob(sessionId);
  }

  // ── YouTube ─────────────────────────────────────────────────────────────────

  async enqueueYoutubeUpload(payload: YouTubeUploadPayload) {
    const jobId = `yt-${payload.sessionId}-${payload.channelId}`;

    const existing = await this.youtubeQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') {
        await existing.remove();
      } else {
        return existing;
      }
    }

    return this.youtubeQueue.add('youtube-upload', payload, {
      ...this.defaultJobOptions(),
      jobId,
    });
  }
}
