import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';
import { QUEUE_RENDER } from '../redis/redis.constants';

export interface RenderJobPayload {
  sessionId: string;
  userId: string;
}

@Injectable()
export class QueuesService {
  constructor(@InjectQueue(QUEUE_RENDER) private readonly renderQueue: Queue) {}

  private defaultRenderJobOptions(): JobsOptions {
    return {
      removeOnComplete: { age: 60 * 60, count: 5000 },
      removeOnFail: { age: 24 * 60 * 60, count: 5000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      // timeout — НЕ тут (в ваших типах JobsOptions его нет)
      // Таймаут делаем в воркере, как “рендер timeout ~ 20 минут” из ТЗ :contentReference[oaicite:1]{index=1}
    };
  }

  async enqueueRender(payload: RenderJobPayload) {
    const jobId = payload.sessionId;

    const existing = await this.renderQueue.getJob(jobId);
    if (existing) return existing; // идемпотентность jobId=sessionId :contentReference[oaicite:2]{index=2}

    return this.renderQueue.add('render', payload, {
      ...this.defaultRenderJobOptions(),
      jobId,
    });
  }

  async getRenderJob(sessionId: string) {
    return this.renderQueue.getJob(sessionId);
  }
}