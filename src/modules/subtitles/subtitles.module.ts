import { Module } from '@nestjs/common';
import { SubtitlesService } from './subtitles.service';

@Module({
  providers: [SubtitlesService],
  exports: [SubtitlesService],
})
export class SubtitlesModule {}