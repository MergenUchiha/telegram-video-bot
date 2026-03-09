import { Inject, Injectable, Logger } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { JokesParserService } from './jokes-parser.service';

@Injectable()
export class JokesCacheService {
  private readonly logger = new Logger(JokesCacheService.name);
  private readonly CACHE_KEY = 'jokes:pool';
  private readonly META_KEY = 'jokes:pool:meta';

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: IORedis,
    private readonly parser: JokesParserService,
  ) {}

  /**
   * Получить пул анекдотов.
   * Пул не имеет TTL — хранится до явного вызова refreshCache() или invalidate().
   * refreshCache() вызывается когда пул исчерпан (из воркера) или вручную через бот.
   */
  async getPool(): Promise<string[]> {
    try {
      const cached = await this.redis.get(this.CACHE_KEY);
      if (cached) {
        const pool = JSON.parse(cached) as string[];
        this.logger.debug(`Jokes pool HIT: ${pool.length} jokes`);
        return pool;
      }
    } catch (e: any) {
      this.logger.warn(`Pool read error: ${e?.message}`);
    }
    return this.refreshCache();
  }

  async refreshCache(): Promise<string[]> {
    this.logger.log('Fetching fresh jokes pool from sources...');

    let jokes: string[] = [];
    try {
      jokes = await this.parser.fetchJokes();
    } catch (e: any) {
      this.logger.warn(`Fetch failed: ${e?.message}`);
    }

    if (jokes.length === 0) {
      try {
        const stale = await this.redis.get(this.CACHE_KEY);
        if (stale) {
          jokes = JSON.parse(stale) as string[];
          this.logger.warn(
            `Using existing pool (${jokes.length} jokes) — fetch failed`,
          );
          return jokes;
        }
      } catch {}
      jokes = await this.parser.fetchJokes();
    }

    const meta = { count: jokes.length, refreshedAt: new Date().toISOString() };

    await this.redis
      .pipeline()
      .set(this.CACHE_KEY, JSON.stringify(jokes))
      .set(this.META_KEY, JSON.stringify(meta))
      .exec();

    this.logger.log(`Jokes pool saved: ${jokes.length} jokes`);
    return jokes;
  }

  async invalidate(): Promise<void> {
    await this.redis.del(this.CACHE_KEY, this.META_KEY);
    this.logger.log('Jokes pool invalidated');
  }

  async getMeta(): Promise<{
    cached: boolean;
    count: number;
    refreshedAt: string | null;
  }> {
    try {
      const metaRaw = await this.redis.get(this.META_KEY);
      if (metaRaw) {
        const meta = JSON.parse(metaRaw);
        return {
          cached: true,
          count: meta.count,
          refreshedAt: meta.refreshedAt,
        };
      }
    } catch {}
    return { cached: false, count: 0, refreshedAt: null };
  }
}
