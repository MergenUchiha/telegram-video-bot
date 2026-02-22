import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION } from './redis.constants';

@Injectable()
export class RedisService implements OnModuleDestroy {
  constructor(@Inject(REDIS_CONNECTION) public readonly redis: IORedis) {}

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      // ignore
    }
  }
}