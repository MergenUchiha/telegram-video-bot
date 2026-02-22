import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './modules/worker/worker.module';

async function bootstrap() {
  const logger = new Logger('WorkerBootstrap');

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });

  // 🔥 важно: включает хуки shutdown
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);

  logger.log('Worker started');
  await app.init();
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Worker bootstrap failed:', e);
  process.exit(1);
});