import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { buildBullMQOptions } from './bullmq.config';
import { QUEUE_RENDER, QUEUE_YOUTUBE } from '../redis/redis.constants';
import { QueuesService } from './queues.service';

@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildBullMQOptions(config),
    }),
    BullModule.registerQueue({ name: QUEUE_RENDER }, { name: QUEUE_YOUTUBE }),
  ],
  providers: [QueuesService],
  exports: [QueuesService],
})
export class QueuesModule {}
