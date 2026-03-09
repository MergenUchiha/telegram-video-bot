import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { RedisModule } from '../redis/redis.module';
import { AutonomyModule } from '../autonomy/autonomy.module';

@Module({
  imports: [RedisModule, AutonomyModule],
  providers: [MetricsService],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class MetricsModule {}
