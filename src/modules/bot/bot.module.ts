import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { TelegramFilesModule } from '../telegram-files/telegram-files.module';
import { QueuesModule } from '../queues/queues.module';
import { RedisModule } from '../redis/redis.module';
import { RateLimitService } from './rate-limit.service';

@Module({
  imports: [
    SessionsModule,
    StorageModule,
    TelegramFilesModule,
    QueuesModule,
    RedisModule,
  ],
  providers: [BotService, BotUpdate, RateLimitService],
})
export class BotModule {}
