import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './modules/prisma/prisma.module';
import { BotModule } from './modules/bot/bot.module';
import { RedisModule } from './modules/redis/redis.module';
import { QueuesModule } from './modules/queues/queues.module';
import { StorageModule } from './modules/storage/storage.module';
import { TelegramFilesModule } from './modules/telegram-files/telegram-files.module';
import { TelegramSenderModule } from './modules/telegram-sender/telegram-sender.module';
import { TtsModule } from './modules/tts/tts.module';
import { MediaProbeModule } from './modules/media-probe/media-probe.module';
import { SubtitlesModule } from './modules/subtitles/subtitles.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { JokesModule } from './modules/jokes/jokes.module';
import { LibraryModule } from './modules/library/library.module';
import { TextCardModule } from './modules/text-card/text-card.module';
import { EncryptionModule } from './modules/encryption/encryption.module';
import { HealthModule } from './modules/health/health.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { YouTubeModule } from './modules/youtube/youtube.module';
import { validateEnv } from './common/config/env.validation';

/**
 * AppModule — только для API-сервера (main.ts).
 * НЕ импортирует WorkerModule — воркер запускается отдельным процессом (worker.ts).
 *
 * Это позволяет:
 *  - Масштабировать воркеры отдельно: docker compose up --scale worker=3
 *  - Не запускать BullMQ processor в API-процессе
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // Инфраструктура
    PrismaModule,
    RedisModule,
    StorageModule,
    EncryptionModule,
    // Бизнес-модули
    TelegramFilesModule,
    TelegramSenderModule,
    TtsModule,
    MediaProbeModule,
    SubtitlesModule,
    QueuesModule,
    SessionsModule,
    YouTubeModule,
    // Фичи
    BotModule,
    MetricsModule,
    JokesModule,
    LibraryModule,
    TextCardModule,
    // Мониторинг
    HealthModule,
  ],
})
export class AppModule {}
