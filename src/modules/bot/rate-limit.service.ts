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

    // Atomic INCR + conditional EXPIRE via Lua script
    const lua = `
      local count = redis.call("INCR", KEYS[1])
      local ttl = redis.call("TTL", KEYS[1])
      if ttl < 0 then
        redis.call("EXPIRE", KEYS[1], ARGV[1])
        ttl = tonumber(ARGV[1])
      end
      return {count, ttl}
    `;
    const result = (await this.redis.eval(
      lua,
      1,
      key,
      String(this.windowSec),
    )) as [number, number];

    const count = Number(result[0]);
    const ttl = Number(result[1]);

    const allowed = count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - count);

    return { allowed, remaining, resetInSec: ttl };
  }
}
