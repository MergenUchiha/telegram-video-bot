import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { LibraryBotHandler } from './library-bot.handler';
import { BotContextHelper } from './bot-context.helper';
import { WaitStateService } from './wait-state.service';
import { StandardSettingsHandler } from './handlers/standard-settings.handler';
import { AutoJokesHandler } from './handlers/auto-jokes.handler';
import { TextInputHandler } from './handlers/text-input.handler';
import { VideoUploadHandler } from './handlers/video-upload.handler';
import { RateLimitService } from './rate-limit.service';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { TelegramFilesModule } from '../telegram-files/telegram-files.module';
import { QueuesModule } from '../queues/queues.module';
import { RedisModule } from '../redis/redis.module';
import { LibraryModule } from '../library/library.module';
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
  providers: [
    // Core
    BotService,
    BotUpdate,
    LibraryBotHandler,
    RateLimitService,
    // Shared helpers
    BotContextHelper,
    WaitStateService,
    // Feature handlers
    StandardSettingsHandler,
    AutoJokesHandler,
    TextInputHandler,
    VideoUploadHandler,
  ],
})
export class BotModule {}
