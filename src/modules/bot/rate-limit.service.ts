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

  /**
   * INCR and EXPIRE as one server-side step.
   *
   * Run separately, two callers can both see count == 1 and the window can be
   * re-armed on every request — or, if the process dies between them, the key
   * never expires and the user stays blocked for good.
   */
  private static readonly INCREMENT_AND_ARM = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return {count, redis.call('TTL', KEYS[1])}
  `;

  async check(
    userId: string,
    action: RateLimitAction = 'command',
  ): Promise<RateLimitResult> {
    const { max, windowSec } = this.limits[action];
    const key = `ratelimit:${action}:${userId}`;

    const [count, ttl] = (await this.redis.eval(
      RateLimitService.INCREMENT_AND_ARM,
      1,
      key,
      windowSec,
    )) as [number, number];

    return {
      allowed: count <= max,
      remaining: Math.max(0, max - count),
      resetInSec: ttl > 0 ? ttl : windowSec,
    };
  }
}
