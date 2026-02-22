import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { RedisModule } from '../redis/redis.module';
import { QueuesModule } from '../queues/queues.module';
import { RenderProcessor } from './render.processor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,     // прогресс/локи
    QueuesModule,    // BullMQ root + registerQueue(render)
  ],
  providers: [RenderProcessor],
})
export class WorkerModule {}