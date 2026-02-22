import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { buildBullMQOptions } from '../modules/queues/bullmq.config';
import { QUEUE_RENDER } from '../modules/redis/redis.constants';

import { RedisModule } from '../modules/redis/redis.module';
import { SessionsModule } from '../modules/sessions/sessions.module';
import { StorageModule } from '../modules/storage/storage.module';
import { PrismaModule } from '../modules/prisma/prisma.module';
import { TelegramSenderModule } from '../modules/telegram-sender/telegram-sender.module';

import { RenderProcessor } from './render.processor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildBullMQOptions(config),
    }),
    BullModule.registerQueue({ name: QUEUE_RENDER }),

    PrismaModule,
    SessionsModule,
    StorageModule,
    RedisModule,
    TelegramSenderModule,
  ],
  providers: [RenderProcessor],
})
export class WorkerModule {}
