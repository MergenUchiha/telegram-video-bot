import { Inject, Injectable, Logger } from '@nestjs/common';
import type IORedis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CONNECTION } from '../redis.constants';
import type { WaitState } from '../../bot/bot.types';

/**
 * Хранит состояние ожидания текстового ввода в Redis.
 *
 * Заменяет in-memory Map — данные переживают рестарт процесса.
 * TTL по умолчанию: 10 минут (WAIT_STATE_TTL_SEC в .env).
 */
@Injectable()
export class WaitStateService {
  private readonly logger = new Logger(WaitStateService.name);
  private readonly ttlSec: number;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: IORedis,
    private readonly config: ConfigService,
  ) {
    this.ttlSec = Number(this.config.get<string>('WAIT_STATE_TTL_SEC', '600'));
  }

  private key(sessionId: string): string {
    return `wait_state:${sessionId}`;
  }

  async set(sessionId: string, state: WaitState): Promise<void> {
    try {
      await this.redis.set(
        this.key(sessionId),
        JSON.stringify(state),
        'EX',
        this.ttlSec,
      );
    } catch (e: any) {
      this.logger.error(`WaitState set failed for ${sessionId}: ${e.message}`);
    }
  }

  async get(sessionId: string): Promise<WaitState | undefined> {
    try {
      const raw = await this.redis.get(this.key(sessionId));
      if (!raw) return undefined;
      return JSON.parse(raw) as WaitState;
    } catch (e: any) {
      this.logger.warn(`WaitState get failed for ${sessionId}: ${e.message}`);
      return undefined;
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.redis.del(this.key(sessionId));
    } catch (e: any) {
      this.logger.warn(
        `WaitState delete failed for ${sessionId}: ${e.message}`,
      );
    }
  }

  async has(sessionId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.key(sessionId))) === 1;
    } catch {
      return false;
    }
  }
}
