import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  logger.log('before create');
  const app = await NestFactory.create(AppModule);
  logger.log('before listen');

  await app.listen(Number(process.env.PORT ?? 5005), '127.0.0.1');

  logger.log(`after listen on ${await app.getUrl()}`);
}
bootstrap();
