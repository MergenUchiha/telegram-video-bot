import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CONNECTION } from '../redis/redis.constants';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSec: number;
}

@Injectable()
export class RateLimitService {
  private readonly maxRequests: number;
  private readonly windowSec: number;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: IORedis,
    private readonly config: ConfigService,
  ) {
    // Максимум N сообщений за окно X секунд (дефолт: 20 за 60с)
    this.maxRequests = Number(config.get<string>('RATE_LIMIT_MAX', '20'));
    this.windowSec = Number(config.get<string>('RATE_LIMIT_WINDOW_SEC', '60'));
  }

  /**
   * Проверяет и инкрементирует счётчик для userId.
   * Использует скользящее окно на базе INCR + EXPIRE.
   */
  async check(userId: string): Promise<RateLimitResult> {
    const key = `ratelimit:user:${userId}`;

    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.ttl(key);
    const results = await pipeline.exec();

    const count = Number((results?.[0]?.[1] as number) ?? 1);
    let ttl = Number((results?.[1]?.[1] as number) ?? -1);

    // Устанавливаем TTL только при первом обращении (когда ttl == -1 или -2)
    if (ttl < 0) {
      await this.redis.expire(key, this.windowSec);
      ttl = this.windowSec;
    }

    const allowed = count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - count);

    return { allowed, remaining, resetInSec: ttl };
  }
}
