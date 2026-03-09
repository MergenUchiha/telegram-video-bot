import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import { BotUpdate } from './bot.update';
import { LibraryBotHandler } from './library-bot.handler';

function formatError(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  if (typeof e === 'string') return { message: e };
  try {
    return { message: JSON.stringify(e) };
  } catch {
    return { message: String(e) };
  }
}

@Injectable()
export class BotService implements OnModuleInit {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly updates: BotUpdate,
    private readonly libraryHandler: LibraryBotHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');

    const bot = new Bot(token);

    // Логируем каждый апдейт в debug-режиме
    bot.use(async (ctx, next) => {
      const u = ctx.update;
      this.logger.log(
        `update: ${Object.keys(u).join(', ')}` +
          (u?.message?.text ? ` text="${u.message.text}"` : ''),
      );
      await next();
    });

    bot.catch((err) => {
      const updateId = err.ctx?.update?.update_id;
      const { message, stack } = formatError(err.error);
      this.logger.error(`Bot error on update ${updateId}: ${message}`, stack);
    });

    // Регистрируем хэндлеры: сначала либо (имеет приоритет по next), затем основные
    this.libraryHandler.register(bot);
    this.updates.register(bot);

    const mode = (
      this.config.get<string>('TELEGRAM_BOT_MODE') ?? 'polling'
    ).toLowerCase();
    if (mode !== 'polling') {
      this.logger.warn(
        'TELEGRAM_BOT_MODE is not polling. For MVP set TELEGRAM_BOT_MODE=polling.',
      );
    }

    this.logger.log('Starting Telegram bot (polling)...');
    await bot.start();
  }
}
