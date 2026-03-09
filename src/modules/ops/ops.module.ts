import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AutonomyModule } from '../autonomy/autonomy.module';
import { QueuesModule } from '../queues/queues.module';
import { RedisModule } from '../redis/redis.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { OpsController } from './ops.controller';

@Module({
  imports: [
    ConfigModule,
    SessionsModule,
    QueuesModule,
    RedisModule,
    StorageModule,
    AutonomyModule,
  ],
  controllers: [OpsController],
})
export class OpsModule {}
