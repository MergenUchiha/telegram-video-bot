import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RedisModule } from '../modules/redis/redis.module';
import { SessionsModule } from '../modules/sessions/sessions.module';
import { StorageModule } from '../modules/storage/storage.module';
import { PrismaModule } from '../modules/prisma/prisma.module';
import { TelegramSenderModule } from '../modules/telegram-sender/telegram-sender.module';
import { TtsModule } from '../modules/tts/tts.module';
import { MediaProbeModule } from '../modules/media-probe/media-probe.module';
import { SubtitlesModule } from '../modules/subtitles/subtitles.module';
import { MetricsModule } from '../modules/metrics/metrics.module';
import { JokesModule } from '../modules/jokes/jokes.module';
import { LibraryModule } from '../modules/library/library.module';
import { TextCardModule } from '../modules/text-card/text-card.module';
import { QueuesModule } from '../modules/queues/queues.module';
import { AutonomyModule } from '../modules/autonomy/autonomy.module';
import { YoutubeModule } from '../modules/youtube/youtube.module';

import { RenderProcessor } from './render.processor';
import { CleanupService } from './cleanup.service';
import { AutonomySchedulerService } from './autonomy-scheduler.service';
import { AutonomyProcessor } from './autonomy.processor';
import { YouTubeUploadProcessor } from './youtube-upload.processor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    SessionsModule,
    StorageModule,
    RedisModule,
    TelegramSenderModule,
    TtsModule,
    MediaProbeModule,
    SubtitlesModule,
    MetricsModule,
    JokesModule,
    LibraryModule,
    TextCardModule,
    QueuesModule,
    AutonomyModule,
    YoutubeModule,
  ],
  providers: [
    RenderProcessor,
    CleanupService,
    AutonomySchedulerService,
    AutonomyProcessor,
    YouTubeUploadProcessor,
  ],
})
export class WorkerModule {}
