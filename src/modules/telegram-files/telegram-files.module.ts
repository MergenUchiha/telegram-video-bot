import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramFilesService } from './telegram-files.service';

@Module({
  imports: [ConfigModule],
  providers: [TelegramFilesService],
  exports: [TelegramFilesService],
})
export class TelegramFilesModule {}