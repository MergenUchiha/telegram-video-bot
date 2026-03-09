import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { ContentMode, RenderSessionState } from '@prisma/client';
import { SessionsService } from '../sessions/sessions.service';
import { QueuesService } from '../queues/queues.service';
import { ProgressService } from '../redis/progress.service';
import { WaitStateService } from '../redis/wait-state/wait-state.service';
import { RateLimitService } from './rate-limit.service';
import { BotContextHelper } from './bot-context.helper';
import { StandardSettingsHandler } from './handlers/standard-settings.handler';
import { AutoJokesHandler } from './handlers/auto-jokes.handler';
import { TextInputHandler } from './handlers/text-input.handler';
import { VideoUploadHandler } from './handlers/video-upload.handler';
import { MAIN_MENU_TEXT } from './bot.constants';
import { autoPanelText, standardPanelText } from './panels/index';
import {
  autoPanelKeyboard,
  mainMenuKeyboard,
  standardPanelKeyboard,
} from './keyboards/index';

@Injectable()
export class BotUpdate {
  constructor(
    private readonly sessions: SessionsService,
    private readonly queues: QueuesService,
    private readonly progress: ProgressService,
    private readonly rateLimit: RateLimitService,
    private readonly helper: BotContextHelper,
    private readonly waitState: WaitStateService,
    private readonly standardSettingsHandler: StandardSettingsHandler,
    private readonly autoJokesHandler: AutoJokesHandler,
    private readonly textInputHandler: TextInputHandler,
    private readonly videoUploadHandler: VideoUploadHandler,
  ) {}

  register(bot: Bot): void {
    this.setCommands(bot);
    this.registerRateLimitMiddleware(bot);
    this.registerCommands(bot);
    this.registerMenuCallbacks(bot);
    this.registerStatusCallbacks(bot);
    this.registerRenderCallback(bot);

    this.videoUploadHandler.register(bot);
    this.standardSettingsHandler.register(bot);
    this.autoJokesHandler.register(bot);
    this.textInputHandler.register(bot);
  }

  private setCommands(bot: Bot): void {
    void bot.api.setMyCommands([
      { command: 'start', description: '🏠 Главное меню' },
      { command: 'status', description: '📊 Статус рендера' },
    ]);
  }

  private registerRateLimitMiddleware(bot: Bot): void {
    bot.use(async (ctx, next) => {
      const uid = String(ctx.from?.id ?? 'unknown');
      const rl = await this.rateLimit.check(uid, 'command');
      if (!rl.allowed) {
        const msg = `⏳ Слишком много запросов. Попробуй через ${rl.resetInSec}с.`;
        try {
          ctx.callbackQuery
            ? await ctx.answerCallbackQuery({ text: msg, show_alert: true })
            : await ctx.reply(msg);
        } catch {}
        return;
      }
      return next();
    });
  }

  private registerCommands(bot: Bot): void {
    bot.command('start', async (ctx) => {
      await this.showMainMenu(ctx);
    });

    bot.command('status', async (ctx) => {
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('Нет активной сессии. Нажми /start.');

      const [cachedStatus, prog, lastError] = await Promise.all([
        this.progress.getStatus(session.id),
        this.progress.getProgress(session.id),
        this.progress.getLastError(session.id),
      ]);

      const lines = [
        `<b>Состояние:</b> ${cachedStatus?.state ?? session.state}`,
        typeof prog === 'number' ? `<b>Прогресс:</b> ${prog}%` : null,
        cachedStatus?.message ? `<b>Статус:</b> ${cachedStatus.message}` : null,
        lastError
          ? `<b>Ошибка:</b> ${lastError.length > 300 ? '…' + lastError.slice(-300) : lastError}`
          : null,
      ]
        .filter(Boolean)
        .join('\n');

      await ctx.reply(lines, { parse_mode: 'HTML' });
    });
  }

  private registerMenuCallbacks(bot: Bot): void {
    bot.callbackQuery('menu:back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (session) await this.waitState.delete(session.id);

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        MAIN_MENU_TEXT,
        mainMenuKeyboard(),
      );

      if (session) {
        await this.sessions.setLastBotMessageId(session.id, null);
      }
    });

    bot.callbackQuery('menu:jokes', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );

      const existing = await this.sessions.getActiveSession(user.id);
      if (existing) {
        if (this.isRendering(existing.state)) {
          return ctx.answerCallbackQuery({
            text: '⏳ Сейчас идёт рендер. Дождись завершения.',
            show_alert: true,
          });
        }
        await this.waitState.delete(existing.id);
      }

      const session = await this.sessions.createSpanishJokesSession(user.id);
      const msgId = ctx.callbackQuery.message?.message_id as number;
      const newId = await this.helper.editPanel(
        ctx,
        msgId,
        autoPanelText(session),
        autoPanelKeyboard(session),
      );
      await this.sessions.setLastBotMessageId(session.id, newId);
    });

    bot.callbackQuery('menu:standard', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );

      const existing = await this.sessions.getActiveSession(user.id);
      if (existing) {
        if (this.isRendering(existing.state)) {
          return ctx.answerCallbackQuery({
            text: '⏳ Сейчас идёт рендер. Дождись завершения.',
            show_alert: true,
          });
        }
        await this.waitState.delete(existing.id);
      }

      const session = await this.sessions.createNewSession(user.id);
      const msgId = ctx.callbackQuery.message?.message_id as number;
      const newId = await this.helper.editPanel(
        ctx,
        msgId,
        standardPanelText(session),
        standardPanelKeyboard(session),
      );
      await this.sessions.setLastBotMessageId(session.id, newId);
    });
  }

  private registerStatusCallbacks(bot: Bot): void {
    bot.callbackQuery('status:refresh', async (ctx) => {
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      const [prog, status] = await Promise.all([
        this.progress.getProgress(session.id),
        this.progress.getStatus(session.id),
      ]);
      const msgId = ctx.callbackQuery.message?.message_id as number;

      if (!this.isRendering(session.state)) {
        await ctx.answerCallbackQuery({ text: '✅ Рендер завершён' });
        try {
          await ctx.api.editMessageText(
            this.helper.getChatId(ctx),
            msgId,
            MAIN_MENU_TEXT,
            { reply_markup: mainMenuKeyboard(), parse_mode: 'HTML' },
          );
        } catch {}
        return;
      }

      const text =
        '⏳ <b>Рендер выполняется</b>\n\n' +
        `Прогресс: ${prog ?? 0}%\n` +
        (status?.message ? `Статус: ${status.message}` : '');

      await ctx.answerCallbackQuery({ text: `${prog ?? 0}%` });
      try {
        await ctx.api.editMessageText(this.helper.getChatId(ctx), msgId, text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '🔄 Обновить статус',
            'status:refresh',
          ),
        });
      } catch {}
    });
  }

  private registerRenderCallback(bot: Bot): void {
    bot.callbackQuery('do:approve', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('Нет сессии. /start');

      // Rate limit на рендер (10/сутки)
      const rl = await this.rateLimit.check(String(ctx.from?.id), 'render');
      if (!rl.allowed) {
        return ctx.answerCallbackQuery({
          text: `⏳ Лимит рендеров исчерпан. Сброс через ${Math.ceil(rl.resetInSec / 3600)}ч.`,
          show_alert: true,
        });
      }

      const isAuto = session.contentMode === ContentMode.SPANISH_JOKES_AUTO;

      if (!isAuto && !session.sourceVideoKey) {
        return ctx.answerCallbackQuery({
          text: '❌ Видео не загружено',
          show_alert: true,
        });
      }

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        '⏳ <b>Ставлю в очередь...</b>',
        new InlineKeyboard(),
      );

      await this.sessions.setState(
        session.id,
        RenderSessionState.RENDER_QUEUED,
      );
      await this.progress.setStatus(session.id, {
        state: 'RENDER_QUEUED',
        updatedAt: new Date().toISOString(),
        message: 'В очереди',
      });
      await this.progress.setProgress(session.id, 0);
      await this.waitState.delete(session.id);

      const job = await this.queues.enqueueRender({
        sessionId: session.id,
        userId: user.id,
        chatId: this.helper.getChatId(ctx),
      });

      const modeLabel = isAuto
        ? '🎭 Spanish Jokes Auto'
        : '🎬 Стандартный рендер';
      await this.helper.editPanel(
        ctx,
        msgId,
        `⏳ <b>Рендер поставлен в очередь</b>\n\n` +
          `Режим: ${modeLabel}\n` +
          `Job ID: <code>${job.id}</code>\n\n` +
          `<i>Видео пришлю сюда, как только будет готово.</i>`,
        new InlineKeyboard().text('🔄 Статус', 'status:refresh'),
      );
    });
  }

  private async showMainMenu(ctx: any): Promise<void> {
    const user = await this.sessions.getOrCreateUser(
      String(ctx.from?.id),
      String(ctx.chat?.id),
    );
    const session = await this.sessions.getActiveSession(user.id);

    if (session && this.isRendering(session.state)) {
      const [prog, status] = await Promise.all([
        this.progress.getProgress(session.id),
        this.progress.getStatus(session.id),
      ]);
      const text =
        '⏳ <b>Рендер выполняется</b>\n\n' +
        `Прогресс: ${prog ?? 0}%\n` +
        (status?.message ? `Статус: ${status.message}` : '');

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text(
          '🔄 Обновить статус',
          'status:refresh',
        ),
      });
      return;
    }

    if (session) await this.waitState.delete(session.id);

    await ctx.reply(MAIN_MENU_TEXT, {
      reply_markup: mainMenuKeyboard(),
      parse_mode: 'HTML',
    });
  }

  private isRendering(state: RenderSessionState): boolean {
    return (
      state === RenderSessionState.RENDER_QUEUED ||
      state === RenderSessionState.RENDERING
    );
  }
}
