import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION, REDIS_KEYS, SessionState } from './redis.constants';

export interface SessionStatusCache {
  state: SessionState;
  updatedAt: string; // ISO
  message?: string;  // коротко для UX
}

@Injectable()
export class ProgressService {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: IORedis) {}

  async setStatus(sessionId: string, payload: SessionStatusCache, ttlSec = 60 * 60) {
    const key = REDIS_KEYS.sessionStatus(sessionId);
    await this.redis.set(key, JSON.stringify(payload), 'EX', ttlSec);
  }

  async getStatus(sessionId: string): Promise<SessionStatusCache | null> {
    const key = REDIS_KEYS.sessionStatus(sessionId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionStatusCache;
    } catch {
      return null;
    }
  }

  /**
   * Храним прогресс 0..100 отдельно, чтобы быстро дёргать.
   */
  async setProgress(sessionId: string, value: number, ttlSec = 60 * 60) {
    const key = REDIS_KEYS.sessionProgress(sessionId);
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    await this.redis.set(key, String(clamped), 'EX', ttlSec);
  }

  async getProgress(sessionId: string): Promise<number | null> {
    const key = REDIS_KEYS.sessionProgress(sessionId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async setLastError(sessionId: string, message: string, ttlSec = 24 * 60 * 60) {
    await this.redis.set(REDIS_KEYS.sessionLastError(sessionId), message, 'EX', ttlSec);
  }

  async getLastError(sessionId: string): Promise<string | null> {
    return this.redis.get(REDIS_KEYS.sessionLastError(sessionId));
  }
}