import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CONNECTION, REDIS_KEYS } from './redis.constants';

type LockResult = { ok: true; key: string } | { ok: false; key: string };

@Injectable()
export class LockService {
  private readonly ttlMs: number;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: IORedis,
    private readonly config: ConfigService,
  ) {
    this.ttlMs = Number(this.config.get<string>('LOCK_TTL_MS', '1800000')); // 30m
  }

  /**
   * Лок на пользователя: “один рендер одновременно”.
   * value = sessionId для дебага и безопасного unlock.
   */
  async acquireUserRenderLock(
    userId: string,
    sessionId: string,
  ): Promise<LockResult> {
    const key = REDIS_KEYS.userActiveLock(userId);
    const res = await this.redis.set(key, sessionId, 'PX', this.ttlMs, 'NX');
    return res === 'OK' ? { ok: true, key } : { ok: false, key };
  }

  /**
   * Продлить лок (например, если рендер дольше).
   * Возвращает false, если лок уже потерян.
   */
  async refreshLock(
    key: string,
    sessionId: string,
    ttlMs = this.ttlMs,
  ): Promise<boolean> {
    const lua = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const res = await this.redis.eval(lua, 1, key, sessionId, String(ttlMs));
    return Number(res) === 1;
  }

  /**
   * Освободить лок только если value == sessionId (безопасно).
   */
  async releaseLock(key: string, sessionId: string): Promise<boolean> {
    const lua = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    const res = await this.redis.eval(lua, 1, key, sessionId);
    return Number(res) === 1;
  }

  async isLocked(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  async acquireGlobalRenderLock(sessionId: string): Promise<LockResult> {
    const key = REDIS_KEYS.globalActiveLock();
    const res = await this.redis.set(key, sessionId, 'PX', this.ttlMs, 'NX');
    return res === 'OK' ? { ok: true, key } : { ok: false, key };
  }
}
