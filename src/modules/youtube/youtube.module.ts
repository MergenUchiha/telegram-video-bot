import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { YoutubeMetadataService } from './youtube-metadata.service';
import { YoutubeService } from './youtube.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [YoutubeMetadataService, YoutubeService],
  exports: [YoutubeMetadataService, YoutubeService],
})
export class YoutubeModule {}
