import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION } from '../redis/redis.constants';

export interface PickResult {
  joke: string;
  poolExhausted: boolean;
}

@Injectable()
export class UsedJokesService {
  private readonly logger = new Logger(UsedJokesService.name);
  private readonly TTL_SEC = 90 * 24 * 60 * 60;

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: IORedis) {}

  private key(userId: string): string {
    return `jokes:used:${userId}`;
  }

  private hash(text: string): string {
    return createHash('sha256').update(text.trim()).digest('hex').slice(0, 32);
  }

  /**
   * Выбрать неиспользованный анекдот из пула.
   * НЕ помечает анекдот как использованный — для этого нужен явный вызов markUsed().
   * Если poolExhausted=true, вызывающий код должен обновить пул и вызвать pick() снова.
   */
  async pick(userId: string, jokes: string[]): Promise<PickResult | null> {
    if (!jokes.length) return null;

    const usedHashes = new Set(await this.redis.smembers(this.key(userId)));
    const candidates = jokes.filter((j) => !usedHashes.has(this.hash(j)));

    if (candidates.length > 0) {
      const picked = candidates[Math.floor(Math.random() * candidates.length)];
      this.logger.debug(
        `User ${userId}: ${candidates.length}/${jokes.length} unused jokes available`,
      );
      return { joke: picked, poolExhausted: false };
    }

    this.logger.log(
      `User ${userId}: pool exhausted (${jokes.length} jokes all used)`,
    );
    return {
      joke: jokes[Math.floor(Math.random() * jokes.length)],
      poolExhausted: true,
    };
  }

  /** Пометить анекдот как использованный. Вызывается только после успешного рендера. */
  async markUsed(userId: string, jokeText: string): Promise<void> {
    const k = this.key(userId);
    await this.redis
      .pipeline()
      .sadd(k, this.hash(jokeText))
      .expire(k, this.TTL_SEC)
      .exec();
    this.logger.debug(`Marked used for user ${userId}`);
  }

  async reset(userId: string): Promise<void> {
    await this.redis.del(this.key(userId));
    this.logger.log(`History reset for user ${userId}`);
  }

  async countUsed(userId: string): Promise<number> {
    return this.redis.scard(this.key(userId));
  }

  async getStats(
    userId: string,
    totalInPool: number,
  ): Promise<{
    used: number;
    total: number;
    remaining: number;
    percent: number;
  }> {
    const used = await this.countUsed(userId);
    const remaining = Math.max(0, totalInPool - used);
    const percent =
      totalInPool > 0 ? Math.round((used / totalInPool) * 100) : 0;
    return { used, total: totalInPool, remaining, percent };
  }
}
