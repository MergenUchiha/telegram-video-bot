import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { buildBullMQOptions } from '../modules/queues/bullmq.config';
import { QUEUE_RENDER } from '../modules/redis/redis.constants';

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

import { RenderProcessor } from './render.processor';
import { CleanupService } from './cleanup.service';
import { FfmpegService } from './services/ffmpeg.service';
import { StandardRenderService } from './services/standard-render.service';
import { JokesRenderService } from './services/jokes-render.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildBullMQOptions(config),
    }),
    BullModule.registerQueue({ name: QUEUE_RENDER }),
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
  ],
  providers: [
    // Worker core
    RenderProcessor,
    CleanupService,
    // Render services
    FfmpegService,
    StandardRenderService,
    JokesRenderService,
  ],
})
export class WorkerModule {}
