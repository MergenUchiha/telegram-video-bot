import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { HealthController } from '../src/modules/health/health.controller';
import {
  HealthService,
  HealthStatus,
} from '../src/modules/health/health.service';

/**
 * Exercises the health endpoints against a stubbed HealthService.
 *
 * Booting AppModule would need Postgres, Redis, S3 and a Telegram token, so
 * this covers the controller and its routing without that. The previous
 * version imported AppModule and asserted "Hello World!" on `/`, a route this
 * application has never had.
 */
describe('HealthController (e2e)', () => {
  let app: INestApplication;

  const healthy: HealthStatus = {
    status: 'ok',
    uptime: 1,
    timestamp: new Date().toISOString(),
    services: {
      redis: { status: 'ok' },
      database: { status: 'ok' },
      storage: { status: 'ok' },
    },
  };

  const check = jest.fn<Promise<HealthStatus>, []>();

  beforeEach(async () => {
    check.mockResolvedValue(healthy);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: { check } }],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    check.mockReset();
  });

  it('GET /health/live answers without touching any dependency', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });

    expect(check).not.toHaveBeenCalled();
  });

  it('GET /health reports every dependency', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(Object.keys(res.body.services).sort()).toEqual([
      'database',
      'redis',
      'storage',
    ]);
  });

  it('GET /health/ready is ready only while every dependency is ok', async () => {
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ready' });

    check.mockResolvedValue({
      ...healthy,
      status: 'degraded',
      services: {
        ...healthy.services,
        redis: { status: 'error', error: 'connection refused' },
      },
    });

    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'not_ready' });
  });
});
