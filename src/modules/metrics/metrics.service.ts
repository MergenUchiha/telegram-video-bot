import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION } from '../redis/redis.constants';

export interface JobMetricEntry {
  sessionId: string;
  status: 'done' | 'failed';
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface MetricsSummary {
  totalDone: number;
  totalFailed: number;
  failRate: string;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  lastJobs: JobMetricEntry[];
}

const KEYS = {
  counterDone: 'metrics:jobs:done',
  counterFailed: 'metrics:jobs:failed',
  durationsZset: 'metrics:jobs:durations', // score=durationMs, member=sessionId:ts
  lastJobs: 'metrics:jobs:last', // list, max 100 entries (JSON)
};

const MAX_LAST_JOBS = 100;
const METRICS_TTL_DAYS = 30;
const METRICS_TTL_SEC = METRICS_TTL_DAYS * 24 * 60 * 60;

@Injectable()
export class MetricsService {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: IORedis) {}

  async recordJobDone(entry: Omit<JobMetricEntry, 'status'>): Promise<void> {
    const e: JobMetricEntry = { ...entry, status: 'done' };
    const ts = Date.now();

    const pipeline = this.redis.pipeline();
    pipeline.incr(KEYS.counterDone);
    pipeline.expire(KEYS.counterDone, METRICS_TTL_SEC);

    // Добавляем в sorted set для перцентилей (score=duration)
    pipeline.zadd(
      KEYS.durationsZset,
      entry.durationMs,
      `${entry.sessionId}:${ts}`,
    );
    pipeline.expire(KEYS.durationsZset, METRICS_TTL_SEC);

    // Добавляем в конец списка последних задач, обрезаем до MAX_LAST_JOBS
    pipeline.lpush(KEYS.lastJobs, JSON.stringify(e));
    pipeline.ltrim(KEYS.lastJobs, 0, MAX_LAST_JOBS - 1);
    pipeline.expire(KEYS.lastJobs, METRICS_TTL_SEC);

    await pipeline.exec();
  }

  async recordJobFailed(entry: Omit<JobMetricEntry, 'status'>): Promise<void> {
    const e: JobMetricEntry = { ...entry, status: 'failed' };

    const pipeline = this.redis.pipeline();
    pipeline.incr(KEYS.counterFailed);
    pipeline.expire(KEYS.counterFailed, METRICS_TTL_SEC);
    pipeline.lpush(KEYS.lastJobs, JSON.stringify(e));
    pipeline.ltrim(KEYS.lastJobs, 0, MAX_LAST_JOBS - 1);
    pipeline.expire(KEYS.lastJobs, METRICS_TTL_SEC);

    await pipeline.exec();
  }

  async getSummary(): Promise<MetricsSummary> {
    const [doneRaw, failedRaw, lastRaw, allDurationsRaw] = await Promise.all([
      this.redis.get(KEYS.counterDone),
      this.redis.get(KEYS.counterFailed),
      this.redis.lrange(KEYS.lastJobs, 0, 19), // последние 20
      this.redis.zrange(KEYS.durationsZset, 0, -1, 'WITHSCORES'),
    ]);

    const totalDone = Number(doneRaw ?? 0);
    const totalFailed = Number(failedRaw ?? 0);
    const total = totalDone + totalFailed;
    const failRate =
      total > 0 ? ((totalFailed / total) * 100).toFixed(1) + '%' : '0%';

    // Парсим durations из WITHSCORES формата: [member, score, member, score, ...]
    const durations: number[] = [];
    for (let i = 1; i < allDurationsRaw.length; i += 2) {
      durations.push(Number(allDurationsRaw[i]));
    }
    durations.sort((a, b) => a - b);

    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length)
        : 0;
    const p50DurationMs =
      durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : 0;
    const p95DurationMs =
      durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : 0;

    const lastJobs: JobMetricEntry[] = lastRaw
      .map((raw) => {
        try {
          return JSON.parse(raw) as JobMetricEntry;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as JobMetricEntry[];

    return {
      totalDone,
      totalFailed,
      failRate,
      avgDurationMs,
      p50DurationMs,
      p95DurationMs,
      lastJobs,
    };
  }
}
