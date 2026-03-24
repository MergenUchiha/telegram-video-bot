import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { LibraryBotHandler } from './library-bot.handler';
import { BotContextHelper } from './bot-context.helper';
import { StandardSettingsHandler } from './handlers/standard-settings.handler';
import { AutoJokesHandler } from './handlers/auto-jokes.handler';
import { TextInputHandler } from './handlers/text-input.handler';
import { VideoUploadHandler } from './handlers/video-upload.handler';
import { YouTubeHandler } from './handlers/youtube.handler';
import { RateLimitService } from './rate-limit.service';
import { SessionsModule } from '../sessions/sessions.module';
import { StorageModule } from '../storage/storage.module';
import { TelegramFilesModule } from '../telegram-files/telegram-files.module';
import { QueuesModule } from '../queues/queues.module';
import { RedisModule } from '../redis/redis.module';
import { LibraryModule } from '../library/library.module';
import { JokesModule } from '../jokes/jokes.module';
import { YouTubeModule } from '../youtube/youtube.module';

@Module({
  imports: [
    SessionsModule,
    StorageModule,
    TelegramFilesModule,
    QueuesModule,
    RedisModule,
    LibraryModule,
    JokesModule,
    YouTubeModule,
  ],
  providers: [
    // Core
    BotService,
    BotUpdate,
    LibraryBotHandler,
    RateLimitService,
    // Shared helpers
    BotContextHelper,
    // Feature handlers
    StandardSettingsHandler,
    AutoJokesHandler,
    TextInputHandler,
    VideoUploadHandler,
    YouTubeHandler,
  ],
})
export class BotModule {}
