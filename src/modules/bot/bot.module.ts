import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { LibraryBotHandler } from './library-bot.handler';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { TelegramFilesModule } from '../telegram-files/telegram-files.module';
import { QueuesModule } from '../queues/queues.module';
import { RedisModule } from '../redis/redis.module';
import { LibraryModule } from '../library/library.module';
import { RateLimitService } from './rate-limit.service';
import { JokesModule } from '../jokes/jokes.module';

@Module({
  imports: [
    SessionsModule,
    StorageModule,
    TelegramFilesModule,
    QueuesModule,
    RedisModule,
    LibraryModule,
    JokesModule,
  ],
  providers: [BotService, BotUpdate, LibraryBotHandler, RateLimitService],
})
export class BotModule {}
