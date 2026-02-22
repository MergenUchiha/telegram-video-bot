import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramSenderService } from './telegram-sender.service';

@Module({
  imports: [ConfigModule],
  providers: [TelegramSenderService],
  exports: [TelegramSenderService],
})
export class TelegramSenderModule {}