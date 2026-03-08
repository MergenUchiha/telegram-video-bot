import {
  Controller,
  Get,
  Headers,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from './metrics.service';

/**
 * GET /metrics
 * Требует заголовок: Authorization: Bearer <METRICS_TOKEN>
 * Если METRICS_TOKEN не задан — эндпоинт открыт (dev режим).
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @HttpCode(200)
  async getMetrics(@Headers('authorization') auth: string) {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (token) {
      const provided = (auth || '').replace(/^Bearer\s+/i, '').trim();
      if (provided !== token)
        throw new UnauthorizedException('Invalid metrics token');
    }

    const summary = await this.metrics.getSummary();

    return {
      jobs: {
        done: summary.totalDone,
        failed: summary.totalFailed,
        failRate: summary.failRate,
      },
      duration: {
        avgMs: summary.avgDurationMs,
        avgHuman: this.msToHuman(summary.avgDurationMs),
        p50Ms: summary.p50DurationMs,
        p50Human: this.msToHuman(summary.p50DurationMs),
        p95Ms: summary.p95DurationMs,
        p95Human: this.msToHuman(summary.p95DurationMs),
      },
      lastJobs: summary.lastJobs.map((j) => ({
        sessionId: j.sessionId,
        status: j.status,
        durationMs: j.durationMs,
        durationHuman: this.msToHuman(j.durationMs),
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        error: j.error ?? null,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  private msToHuman(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }
}
