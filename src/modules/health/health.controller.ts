import { Controller, Get, HttpCode } from '@nestjs/common';
import { HealthService, HealthStatus } from './health.service';

/**
 * GET /health        — полный статус (для мониторинга)
 * GET /health/live   — liveness probe (для Docker/k8s)
 * GET /health/ready  — readiness probe
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @HttpCode(200)
  async check(): Promise<HealthStatus> {
    return this.health.check();
  }

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string }> {
    const status = await this.health.check();
    const allHealthy = Object.values(status.services).every(
      (s) => s.status === 'ok',
    );
    return { status: allHealthy ? 'ready' : 'not_ready' };
  }
}
