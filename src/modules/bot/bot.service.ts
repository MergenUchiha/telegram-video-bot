import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import { BotUpdate } from './bot.update';

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly updates: BotUpdate,
  ) {}

  async onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');

    const bot = new Bot(token);
    this.updates.register(bot);

    const mode = (this.config.get<string>('TELEGRAM_BOT_MODE') ?? 'polling').toLowerCase();
    if (mode !== 'polling') {
      this.logger.warn('TELEGRAM_BOT_MODE is not polling. For MVP set TELEGRAM_BOT_MODE=polling.');
    }

    this.logger.log('Starting Telegram bot (polling)...');
    await bot.start();
  }
}