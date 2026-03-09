import { Inject, Injectable, Logger } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export interface ServiceHealth {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  uptime: number;
  timestamp: string;
  services: {
    redis: ServiceHealth;
    database: ServiceHealth;
    storage: ServiceHealth;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: IORedis,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async check(): Promise<HealthStatus> {
    const [redis, database, storage] = await Promise.all([
      this.checkRedis(),
      this.checkDatabase(),
      this.checkStorage(),
    ]);

    const allOk = [redis, database, storage].every((s) => s.status === 'ok');

    return {
      status: allOk ? 'ok' : 'degraded',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      services: { redis, database, storage },
    };
  }

  private async checkRedis(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') throw new Error('Unexpected PING response');
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (e: any) {
      this.logger.warn(`Redis health check failed: ${e.message}`);
      return { status: 'error', error: e.message };
    }
  }

  private async checkDatabase(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (e: any) {
      this.logger.warn(`Database health check failed: ${e.message}`);
      return { status: 'error', error: e.message };
    }
  }

  private async checkStorage(): Promise<ServiceHealth> {
    const start = Date.now();
    try {
      await this.storage.ensureBucketExists();
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (e: any) {
      this.logger.warn(`Storage health check failed: ${e.message}`);
      return { status: 'error', error: e.message };
    }
  }
}
