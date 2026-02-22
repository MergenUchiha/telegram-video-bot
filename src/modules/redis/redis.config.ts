import type { RedisOptions } from 'ioredis';
import { ConfigService } from '@nestjs/config';

export function buildRedisOptions(config: ConfigService): RedisOptions {
  const host = config.get<string>('REDIS_HOST', '127.0.0.1');
  const port = Number(config.get<string>('REDIS_PORT', '6379'));
  const password = config.get<string>('REDIS_PASSWORD', '') || undefined;
  const db = Number(config.get<string>('REDIS_DB', '0'));
  const tlsEnabled = config.get<string>('REDIS_TLS', '0') === '1';

  return {
    host,
    port,
    password,
    db,

    // 👇 фикс IPv6 ::1
    family: 4,

    // стабильные дефолты для BullMQ/ioredis
    maxRetriesPerRequest: null,
    enableReadyCheck: false,

    ...(tlsEnabled ? { tls: {} } : {}),
  };
}