import { Global, Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

import { REDIS_CONNECTION } from './redis.constants';
import { buildRedisOptions } from './redis.config';
import { RedisService } from './redis.service';
import { LockService } from './lock.service';
import { ProgressService } from './progress.service';
import { WaitStateService } from './wait-state/wait-state.service';
import { errorMessage, hasErrorCode } from '../../common/errors';

/**
 * ioredis reports a failed multi-address connect as an AggregateError whose
 * `errors` carry the address that was tried, which is the useful part.
 */
interface ConnectAttemptError {
  message?: string;
  code?: string;
  address?: string;
  port?: number;
}

function isAggregate(err: unknown): err is { errors: ConnectAttemptError[] } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'errors' in err &&
    Array.isArray(err.errors)
  );
}

function describeAttempt(e: ConnectAttemptError): string {
  const addr = e.address ? ` @ ${e.address}:${e.port ?? ''}` : '';
  const code = e.code ? ` (${e.code})` : '';
  return `- ${e.message ?? 'Unknown error'}${code}${addr}`;
}

function formatRedisError(err: unknown): string {
  if (!isAggregate(err)) {
    const code = hasErrorCode(err) ? ` code=${err.code}` : '';
    return `${errorMessage(err)}${code}`;
  }

  const lines = err.errors.map(describeAttempt);
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
        client.on('reconnecting', (delay: number) =>
          logger.warn(`reconnecting in ${delay}ms...`),
        );
        client.on('close', () => logger.warn('connection closed'));
        client.on('end', () => logger.warn('connection ended'));
        client.on('error', (err) => logger.error(formatRedisError(err)));

        return client;
      },
    },
    RedisService,
    LockService,
    ProgressService,
    WaitStateService,
  ],
  exports: [
    REDIS_CONNECTION,
    RedisService,
    LockService,
    ProgressService,
    WaitStateService,
  ],
})
export class RedisModule {}
