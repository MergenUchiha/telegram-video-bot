import { ConfigService } from '@nestjs/config';
import type { BullRootModuleOptions } from '@nestjs/bullmq';
import { buildRedisOptions } from '../redis/redis.config';

export function buildBullMQOptions(config: ConfigService): BullRootModuleOptions {
  const prefix = config.get<string>('BULLMQ_PREFIX', 'tvb');

  return {
    prefix,
    connection: buildRedisOptions(config),
  };
}