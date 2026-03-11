import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot } from 'grammy';
import { BotUpdate } from './bot.update';
import { LibraryBotHandler } from './library-bot.handler';
import { AutonomyBotHandler } from '../autonomy/autonomy-bot.handler';

function formatUnknownError(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  if (typeof e === 'string') return { message: e };
  try {
    return { message: JSON.stringify(e) };
  } catch {
    return { message: String(e) };
  }
}

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot: Bot | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly updates: BotUpdate,
    private readonly libraryHandler: LibraryBotHandler,
    private readonly autonomyHandler: AutonomyBotHandler,
  ) {}

  async onModuleInit() {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token === 'your_token_here') {
      this.logger.warn(
        'Telegram bot startup skipped because TELEGRAM_BOT_TOKEN is not configured.',
      );
      return;
    }

    const bot = new Bot(token);

    bot.use(async (ctx, next) => {
      const u = ctx.update;
      this.logger.log(
        `update received: ${Object.keys(u).join(', ')} ` +
          (u?.message?.text ? `text="${u.message.text}"` : ''),
      );
      await next();
    });

    bot.catch((err) => {
      const updateId = err.ctx?.update?.update_id;
      const { message, stack } = formatUnknownError(err.error);
      this.logger.error(`Bot error on update ${updateId}: ${message}`, stack);
    });

    // ── Регистрируем обработчики ─────────────────────────────────────────
    // Порядок важен: LibraryBotHandler слушает message:document и message:video
    // только когда есть флаг awaitingVideoUpload, поэтому конфликта нет.
    this.libraryHandler.register(bot);
    this.autonomyHandler.register(bot);
    this.updates.register(bot);

    const mode = (
      this.config.get<string>('TELEGRAM_BOT_MODE') ?? 'polling'
    ).toLowerCase();
    if (mode !== 'polling') {
      this.logger.warn(
        'TELEGRAM_BOT_MODE is not polling. For MVP set TELEGRAM_BOT_MODE=polling.',
      );
    }

    this.bot = bot;
    this.logger.log('Starting Telegram bot (polling)...');
    bot.start({
      onStart: () => this.logger.log('Telegram bot polling started'),
    });
  }

  async onModuleDestroy() {
    if (this.bot) {
      this.logger.log('Stopping Telegram bot...');
      await this.bot.stop();
      this.bot = null;
    }
  }
}
