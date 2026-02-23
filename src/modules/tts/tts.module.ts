import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TtsService } from './tts.service';

@Module({
  imports: [
    HttpModule.register({
      // таймаут можно переопределить в сервисе через Config
      timeout: 30_000,
      maxRedirects: 0,
    }),
  ],
  providers: [TtsService],
  exports: [TtsService],
})
export class TtsModule {}
