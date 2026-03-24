import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { buildBullMQOptions } from '../modules/queues/bullmq.config';
import { QUEUE_RENDER, QUEUE_YOUTUBE } from '../modules/redis/redis.constants';
import { QueuesModule } from '../modules/queues/queues.module';

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
import { EncryptionModule } from '../modules/encryption/encryption.module';
import { YouTubeModule } from '../modules/youtube/youtube.module';

import { RenderProcessor } from './render.processor';
import { YouTubeProcessor } from './youtube.processor';
import { CleanupService } from './cleanup.service';
import { FfmpegService } from './services/ffmpeg.service';
import { StandardRenderService } from './services/standard-render.service';
import { JokesRenderService } from './services/jokes-render.service';
import { validateEnv } from 'src/common/config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildBullMQOptions(config),
    }),
    BullModule.registerQueue({ name: QUEUE_RENDER }, { name: QUEUE_YOUTUBE }),
    QueuesModule,
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
    EncryptionModule,
    YouTubeModule,
  ],
  providers: [
    RenderProcessor,
    YouTubeProcessor,
    CleanupService,
    FfmpegService,
    StandardRenderService,
    JokesRenderService,
  ],
})
export class WorkerModule {}
