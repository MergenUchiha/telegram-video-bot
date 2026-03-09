import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionsModule } from '../sessions/sessions.module';
import { QueuesModule } from '../queues/queues.module';
import { LibraryModule } from '../library/library.module';
import { YoutubeModule } from '../youtube/youtube.module';
import { AutonomyService } from './autonomy.service';
import { AutonomyBootstrapService } from './autonomy-bootstrap.service';
import { AutonomyBotHandler } from './autonomy-bot.handler';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    SessionsModule,
    QueuesModule,
    LibraryModule,
    YoutubeModule,
  ],
  providers: [AutonomyService, AutonomyBootstrapService, AutonomyBotHandler],
  exports: [AutonomyService, AutonomyBotHandler],
})
export class AutonomyModule {}
