import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotUpdate } from './bot.update';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [SessionsModule],
  providers: [BotService, BotUpdate],
})
export class BotModule {}