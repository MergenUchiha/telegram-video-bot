import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProgressService } from '../redis/progress.service';
import { LockService } from '../redis/lock.service';
import { QUEUE_RENDER } from '../redis/redis.constants';

type RenderJobPayload = {
  sessionId: string;
  userId: string;
};

@Processor(QUEUE_RENDER, { concurrency: 1 })
export class RenderProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger('RenderProcessor');

  // для graceful shutdown: попытаться освободить лок, если job идёт
  private currentLock: { key: string; sessionId: string } | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly progress: ProgressService,
    private readonly locks: LockService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<RenderJobPayload>): Promise<void> {
    const { sessionId, userId } = job.data;

    const heartbeatMs = Number(this.config.get('RENDER_HEARTBEAT_MS', '30000'));
    const useGlobal = this.config.get<string>('RENDER_GLOBAL_LOCK', '1') === '1';

    this.logger.log(`job started: id=${job.id} session=${sessionId}`);

    // 1) acquire lock
    const lock = useGlobal
      ? await this.locks.acquireGlobalRenderLock(sessionId)
      : await this.locks.acquireUserRenderLock(userId, sessionId);

    if (!lock.ok) {
      // значит уже идёт рендер → пусть BullMQ ретраит позже
      await this.progress.setStatus(sessionId, {
        state: 'RENDER_QUEUED',
        updatedAt: new Date().toISOString(),
        message: 'Waiting: another render is in progress',
      });
      throw new Error(`Render lock is already held: ${lock.key}`);
    }

    this.currentLock = { key: lock.key, sessionId };

    // 2) start heartbeat
    this.heartbeatTimer = setInterval(async () => {
      try {
        const ok = await this.locks.refreshLock(lock.key, sessionId);
        if (!ok) {
          // лок потерян — это критично, дальше работать нельзя
          this.logger.error(`heartbeat failed: lock lost key=${lock.key} session=${sessionId}`);
        } else {
          this.logger.debug(`heartbeat ok: session=${sessionId}`);
        }
      } catch (e: any) {
        this.logger.error(`heartbeat error: ${e?.message || e}`);
      }
    }, heartbeatMs);

    try {
      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'Rendering started',
      });

      // --- ниже пока stub, но здесь будет ffprobe/ffmpeg/kokoro pipeline ---
      for (const p of [5, 20, 50, 80, 100]) {
        // проверка “лок ещё наш” — если heartbeat не смог продлить, прекращаем
        const stillOk = await this.locks.refreshLock(lock.key, sessionId);
        if (!stillOk) throw new Error('Lock lost during render (heartbeat failed)');

        await this.progress.setProgress(sessionId, p);
        await job.updateProgress(p);
        await new Promise((r) => setTimeout(r, 400));
      }

      await this.progress.setStatus(sessionId, {
        state: 'RENDER_DONE',
        updatedAt: new Date().toISOString(),
        message: 'Rendering done (stub)',
      });

      this.logger.log(`job done: session=${sessionId}`);
    } catch (e: any) {
      await this.progress.setLastError(sessionId, e?.message || String(e));
      await this.progress.setStatus(sessionId, {
        state: 'RENDER_FAILED',
        updatedAt: new Date().toISOString(),
        message: 'Render failed',
      });
      throw e; // важно: чтобы BullMQ сделал attempts/backoff :contentReference[oaicite:4]{index=4}
    } finally {
      // 3) stop heartbeat
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }

      // 4) release lock (safe by sessionId)
      try {
        await this.locks.releaseLock(lock.key, sessionId);
      } catch (e: any) {
        this.logger.warn(`release lock failed: ${e?.message || e}`);
      }

      this.currentLock = null;
    }
  }

  async onApplicationShutdown(signal?: string) {
    this.logger.warn(`shutdown: ${signal || 'unknown'}`);

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.currentLock) {
      try {
        await this.locks.releaseLock(this.currentLock.key, this.currentLock.sessionId);
        this.logger.warn(`lock released on shutdown: ${this.currentLock.key}`);
      } catch (e: any) {
        this.logger.warn(`failed to release lock on shutdown: ${e?.message || e}`);
      } finally {
        this.currentLock = null;
      }
    }
  }
}