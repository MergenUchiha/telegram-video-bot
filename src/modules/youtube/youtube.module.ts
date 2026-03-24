import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { YouTubeService } from './youtube.service';
import { YouTubeController } from './youtube.controller';

@Module({
  imports: [ConfigModule, PrismaModule, EncryptionModule],
  providers: [YouTubeService],
  controllers: [YouTubeController],
  exports: [YouTubeService],
})
export class YouTubeModule {}
