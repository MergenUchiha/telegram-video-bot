import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MetricsController } from '../src/modules/metrics/metrics.controller';
import { MetricsService } from '../src/modules/metrics/metrics.service';
import { AutonomyService } from '../src/modules/autonomy/autonomy.service';

describe('MetricsController (e2e)', () => {
  let controller: MetricsController;

  const metricsSummary = {
    totalDone: 3,
    totalFailed: 1,
    failRate: '25.0%',
    avgDurationMs: 1000,
    p50DurationMs: 900,
    p95DurationMs: 1500,
    lastJobs: [
      {
        sessionId: 'session-1',
        status: 'done' as const,
        durationMs: 1000,
        startedAt: '2026-03-09T10:00:00.000Z',
        finishedAt: '2026-03-09T10:00:01.000Z',
      },
    ],
  };

  const autonomySummary = {
    enabled: true,
    configured: true,
    todayTarget: 5,
    todayCompleted: 3,
    todayFailed: 1,
    nextScheduledAt: '2026-03-09T12:00:00.000Z',
    uploadSuccessRate: '75%',
  };

  const metricsServiceMock = {
    getSummary: jest.fn().mockResolvedValue(metricsSummary),
  };

  const autonomyServiceMock = {
    getMetricsSummary: jest.fn().mockResolvedValue(autonomySummary),
  };

  const configServiceMock = {
    get: jest.fn<string | undefined, [string]>((key: string) => {
      if (key === 'METRICS_TOKEN') return undefined;
      return undefined;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        { provide: MetricsService, useValue: metricsServiceMock },
        { provide: ConfigService, useValue: configServiceMock },
        { provide: AutonomyService, useValue: autonomyServiceMock },
      ],
    }).compile();

    controller = moduleFixture.get(MetricsController);
  });

  it('/metrics (GET) returns the metrics payload when auth is disabled', async () => {
    const response = await controller.getMetrics('');

    expect(response).toMatchObject({
      jobs: {
        done: 3,
        failed: 1,
        failRate: '25.0%',
      },
      autonomy: autonomySummary,
    });
    expect(response.generatedAt).toEqual(expect.any(String));
  });

  it('/metrics (GET) rejects invalid bearer token when auth is enabled', async () => {
    configServiceMock.get.mockImplementation((key: string) => {
      if (key === 'METRICS_TOKEN') return 'secret-token';
      return undefined;
    });

    await expect(controller.getMetrics('Bearer wrong-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
