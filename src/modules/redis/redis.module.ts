import { Global, Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

import { REDIS_CONNECTION } from './redis.constants';
import { buildRedisOptions } from './redis.config';
import { RedisService } from './redis.service';
import { LockService } from './lock.service';
import { ProgressService } from './progress.service';

function formatRedisError(err: any): string {
  // AggregateError из node:net (internalConnectMultiple)
  const isAgg = err && typeof err === 'object' && Array.isArray(err.errors);
  if (!isAgg) {
    const code = err?.code ? ` code=${err.code}` : '';
    const msg = err?.message || String(err);
    return `${msg}${code}`;
  }

  const lines = err.errors.map((e: any) => {
    const addr = e?.address ? `${e.address}:${e.port}` : '';
    const code = e?.code ? ` (${e.code})` : '';
    const msg = e?.message || 'Unknown error';
    return `- ${msg}${code}${addr ? ` @ ${addr}` : ''}`;
  });

  return `Redis connection failed (multiple attempts):\n${lines.join('\n')}`;
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Redis');
        const client = new IORedis(buildRedisOptions(config));

        client.on('connect', () => logger.log('connecting...'));
        client.on('ready', () => logger.log('ready'));
        client.on('reconnecting', (delay) => logger.warn(`reconnecting in ${delay}ms...`));
        client.on('close', () => logger.warn('connection closed'));
        client.on('end', () => logger.warn('connection ended'));

        client.on('error', (err) => {
          logger.error(formatRedisError(err));
        });

        return client;
      },
    },
    RedisService,
    LockService,
    ProgressService,
  ],
  exports: [REDIS_CONNECTION, RedisService, LockService, ProgressService],
})
export class RedisModule {}