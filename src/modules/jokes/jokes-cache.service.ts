import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    private readonly config: ConfigService,
    private readonly parser: JokesParserService,
  ) {}

  /**
   * Получить пул анекдотов.
   *
   * Пул НЕ имеет TTL — он хранится до явного вызова refreshCache().
   * refreshCache() вызывается только когда пул исчерпан (из воркера)
   * или вручную через /library jokes_refresh в боте.
   *
   * Это означает: сайты парсятся только тогда, когда реально нужны новые анекдоты.
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

    // Первый запуск или после ручного сброса — грузим
    return this.refreshCache();
  }

  /**
   * Загрузить свежий пул с сайтов и сохранить в Redis без TTL.
   * Вызывается:
   *   1. При первом старте (пул пуст)
   *   2. Когда пользователь исчерпал все анекдоты (из воркера)
   *   3. Вручную через кнопку в боте
   */
  async refreshCache(): Promise<string[]> {
    this.logger.log('Fetching fresh jokes pool from sources...');

    let jokes: string[] = [];
    try {
      jokes = await this.parser.fetchJokes();
    } catch (e: any) {
      this.logger.warn(`Fetch failed: ${e?.message}`);
    }

    if (jokes.length === 0) {
      // Парсинг упал — берём старый пул если есть
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
      // Совсем ничего нет — fallback внутри парсера
      jokes = await this.parser.fetchJokes();
    }

    const meta = {
      count: jokes.length,
      refreshedAt: new Date().toISOString(),
    };

    // Сохраняем БЕЗ TTL — пул живёт до следующего исчерпания
    await this.redis
      .pipeline()
      .set(this.CACHE_KEY, JSON.stringify(jokes))
      .set(this.META_KEY, JSON.stringify(meta))
      .exec();

    this.logger.log(
      `Jokes pool saved: ${jokes.length} jokes (no TTL — refreshed on exhaustion)`,
    );
    return jokes;
  }

  /** Сбросить пул (следующий getPool() перепарсит) */
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
