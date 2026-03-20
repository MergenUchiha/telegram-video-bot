import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CONNECTION } from '../redis/redis.constants';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSec: number;
}

export type RateLimitAction = 'command' | 'upload' | 'render';

interface LimitConfig {
  max: number;
  windowSec: number;
}

/**
 * Rate limiter с раздельными лимитами по типу действия:
 *   - command: обычные команды/кнопки (30/мин)
 *   - upload:  загрузка видео (5/час)
 *   - render:  постановка в очередь рендера (10/сутки)
 */
@Injectable()
export class RateLimitService {
  private readonly limits: Record<RateLimitAction, LimitConfig>;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: IORedis,
    private readonly config: ConfigService,
  ) {
    this.limits = {
      command: {
        max: Number(this.config.get('RATE_LIMIT_MAX', '30')),
        windowSec: Number(this.config.get('RATE_LIMIT_WINDOW_SEC', '60')),
      },
      upload: {
        max: Number(this.config.get('RATE_LIMIT_UPLOAD_MAX', '5')),
        windowSec: Number(
          this.config.get('RATE_LIMIT_UPLOAD_WINDOW_SEC', '3600'),
        ),
      },
      render: {
        max: Number(this.config.get('RATE_LIMIT_RENDER_MAX', '10')),
        windowSec: Number(
          this.config.get('RATE_LIMIT_RENDER_WINDOW_SEC', '86400'),
        ),
      },
    };
  }

  private readonly luaScript = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    local ttl = redis.call('TTL', KEYS[1])
    return {count, ttl}
  `;

  async check(
    userId: string,
    action: RateLimitAction = 'command',
  ): Promise<RateLimitResult> {
    const { max, windowSec } = this.limits[action];
    const key = `ratelimit:${action}:${userId}`;

    const result = (await this.redis.eval(
      this.luaScript,
      1,
      key,
      windowSec,
    )) as [number, number];

    const count = Number(result[0]);
    const ttl = Number(result[1]);

    return {
      allowed: count <= max,
      remaining: Math.max(0, max - count),
      resetInSec: ttl > 0 ? ttl : windowSec,
    };
  }
}
