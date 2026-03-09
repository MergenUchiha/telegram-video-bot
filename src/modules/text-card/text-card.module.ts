import { Module } from '@nestjs/common';
import { TextCardService } from './text-card.service';

@Module({
  providers: [TextCardService],
  exports: [TextCardService],
})
export class TextCardModule {}
