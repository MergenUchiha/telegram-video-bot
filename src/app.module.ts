import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { BotModule } from './modules/bot/bot.module';
import { RedisModule } from './modules/redis/redis.module';
import { QueuesModule } from './modules/queues/queues.module';
import { WorkerModule } from './worker/worker.module';
import { StorageModule } from './modules/storage/storage.module';
import { TelegramFilesModule } from './modules/telegram-files/telegram-files.module';
import { TelegramSenderModule } from './modules/telegram-sender/telegram-sender.module';
import { TtsModule } from './modules/tts/tts.module';
import { MediaProbeModule } from './modules/media-probe/media-probe.module';
import { SubtitlesModule } from './modules/subtitles/subtitles.module';
import { MetricsModule } from './modules/metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    StorageModule,
    TelegramFilesModule,
    TelegramSenderModule,
    TtsModule,
    MediaProbeModule,
    SubtitlesModule,
    QueuesModule,
    BotModule,
    WorkerModule,
    MetricsModule, // GET /metrics endpoint
  ],
})
export class AppModule {}
