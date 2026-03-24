import { Injectable, Logger } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import type { RenderSession } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { BotContextHelper } from '../bot-context.helper';
import { WaitStateService } from '../../redis/wait-state/wait-state.service';
import { QueuesService } from '../../queues/queues.service';
import { YouTubeService } from '../../youtube/youtube.service';

@Injectable()
export class YouTubeHandler {
  private readonly logger = new Logger(YouTubeHandler.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly helper: BotContextHelper,
    private readonly waitState: WaitStateService,
    private readonly queues: QueuesService,
    private readonly youtubeService: YouTubeService,
  ) {}

  register(bot: Bot): void {
    this.registerChannelsCommand(bot);
    this.registerChannelManagement(bot);
    this.registerUploadFlow(bot);
    this.registerCodeInput(bot);
  }

  // ── /channels command ─────────────────────────────────────────────────────

  private registerChannelsCommand(bot: Bot): void {
    bot.command('channels', async (ctx) => {
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const channels = await this.youtubeService.listChannels(user.id);
      const msgId = ctx.message?.message_id;

      const text = this.buildChannelListText(channels);
      const kb = this.buildChannelListKeyboard(channels);

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    });
  }

  // ── Channel management callbacks ──────────────────────────────────────────

  private registerChannelManagement(bot: Bot): void {
    // Connect new channel
    bot.callbackQuery('yt:connect', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );

      const channels = await this.youtubeService.listChannels(user.id);
      if (channels.length >= 5) {
        return ctx.answerCallbackQuery({
          text: '❌ Максимум 5 каналов. Удалите один, чтобы добавить новый.',
          show_alert: true,
        });
      }

      const session = await this.sessions.getActiveSession(user.id);
      const authUrl = this.youtubeService.getAuthUrl(user.id);

      const msgId = ctx.callbackQuery.message?.message_id as number;
      const promptText =
        '🔗 <b>Подключение YouTube-канала</b>\n\n' +
        '1. Перейдите по ссылке ниже\n' +
        '2. Авторизуйтесь и разрешите доступ\n' +
        '3. Скопируйте код и отправьте его сюда\n\n' +
        `<a href="${authUrl}">🔑 Авторизация Google</a>`;

      await this.helper.editPanel(
        ctx,
        msgId,
        promptText,
        new InlineKeyboard().text('← Отмена', 'yt:channels_back'),
      );

      // Set wait state to capture auth code
      if (session) {
        await this.waitState.set(session.id, {
          type: 'youtube_code',
          panelMsgId: msgId,
        });
      }
    });

    // Remove channel
    bot.callbackQuery(/^yt:remove:(.+)$/, async (ctx) => {
      const channelRecordId = ctx.match[1];
      await ctx.answerCallbackQuery();

      await this.youtubeService.removeChannel(channelRecordId);

      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const channels = await this.youtubeService.listChannels(user.id);

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        this.buildChannelListText(channels),
        this.buildChannelListKeyboard(channels),
      );
    });

    // Set default channel
    bot.callbackQuery(/^yt:default:(.+)$/, async (ctx) => {
      const channelRecordId = ctx.match[1];
      await ctx.answerCallbackQuery();

      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );

      await this.youtubeService.setDefault(user.id, channelRecordId);

      const channels = await this.youtubeService.listChannels(user.id);
      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        this.buildChannelListText(channels),
        this.buildChannelListKeyboard(channels),
      );

      await ctx
        .answerCallbackQuery('✅ Канал по умолчанию обновлён')
        .catch(() => {});
    });

    // Back to channel list
    bot.callbackQuery('yt:channels_back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );

      const session = await this.sessions.getActiveSession(user.id);
      if (session) await this.waitState.delete(session.id);

      const channels = await this.youtubeService.listChannels(user.id);
      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        this.buildChannelListText(channels),
        this.buildChannelListKeyboard(channels),
      );
    });
  }

  // ── Upload flow ───────────────────────────────────────────────────────────

  private registerUploadFlow(bot: Bot): void {
    // Upload prompt — called after render completion
    bot.callbackQuery('yt:upload_prompt', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      const channels = await this.youtubeService.listChannels(user.id);
      if (!channels.length) {
        return ctx.answerCallbackQuery({
          text: '❌ Нет подключённых YouTube-каналов. Используйте /channels.',
          show_alert: true,
        });
      }

      if (channels.length === 1) {
        // Only one channel — upload immediately
        await this.enqueueUpload(ctx, session, channels[0].id, user.id);
        return;
      }

      // Multiple channels — show picker
      const msgId = ctx.callbackQuery.message?.message_id as number;
      const kb = new InlineKeyboard();
      for (const ch of channels) {
        const label = ch.isDefault ? `✓ ${ch.channelTitle}` : ch.channelTitle;
        kb.text(label, `yt:upload:${ch.id}`).row();
      }
      kb.text('← Отмена', 'yt:upload_cancel');

      await this.helper.editPanel(
        ctx,
        msgId,
        '📺 <b>Выберите канал для загрузки</b>',
        kb,
      );
    });

    // Upload to specific channel
    bot.callbackQuery(/^yt:upload:(.+)$/, async (ctx) => {
      const channelId = ctx.match[1];
      await ctx.answerCallbackQuery();

      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return;

      await this.enqueueUpload(ctx, session, channelId, user.id);
    });

    // Cancel upload
    bot.callbackQuery('yt:upload_cancel', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Загрузка отменена' });
      const msgId = ctx.callbackQuery.message?.message_id as number;
      try {
        await ctx.api.deleteMessage(this.helper.getChatId(ctx), msgId);
      } catch {}
    });
  }

  // ── YouTube code input (text handler) ─────────────────────────────────────

  private registerCodeInput(bot: Bot): void {
    // This is handled by the text-input.handler pattern
    // The youtube_code WaitType is checked in the text-input handler
    // But we register our own middleware here for priority
    bot.on('message:text', async (ctx, next) => {
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return next();

      const ws = await this.waitState.get(session.id);
      if (!ws || ws.type !== 'youtube_code') return next();

      const code = ctx.message.text.trim();
      if (!code) return next();

      await this.waitState.delete(session.id);
      const panelMsgId = ws.panelMsgId;

      await this.helper.editPanel(
        ctx,
        panelMsgId,
        '⏳ <b>Подключаю YouTube-канал...</b>',
        new InlineKeyboard(),
      );

      try {
        const channel = await this.youtubeService.addChannel(user.id, code);
        const channels = await this.youtubeService.listChannels(user.id);

        await this.helper.editPanel(
          ctx,
          panelMsgId,
          `✅ Канал <b>${channel.channelTitle}</b> подключён!\n\n` +
            this.buildChannelListText(channels),
          this.buildChannelListKeyboard(channels),
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.helper.editPanel(
          ctx,
          panelMsgId,
          `❌ <b>Ошибка подключения:</b>\n${msg.slice(0, 300)}\n\nПопробуйте ещё раз через /channels.`,
          new InlineKeyboard()
            .text('🔄 Повторить', 'yt:connect')
            .text('← Назад', 'yt:channels_back'),
        );
      }

      // Delete the user's code message for security
      try {
        await ctx.api.deleteMessage(
          this.helper.getChatId(ctx),
          ctx.message.message_id,
        );
      } catch {}
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async enqueueUpload(
    ctx: any,
    session: RenderSession,
    channelId: string,
    userId: string,
  ): Promise<void> {
    const chatId = this.helper.getChatId(ctx);
    const channel = await this.youtubeService.getChannelById(channelId);
    const channelName = channel?.channelTitle ?? 'Unknown';

    await this.sessions.setState(session.id, 'YOUTUBE_WAIT_CHANNEL' as any);

    await this.queues.enqueueYoutubeUpload({
      sessionId: session.id,
      channelId,
      chatId,
      userId,
    });

    const msgId = ctx.callbackQuery?.message?.message_id as number;
    if (msgId) {
      try {
        await this.helper.editPanel(
          ctx,
          msgId,
          `📺 <b>Загрузка на YouTube поставлена в очередь</b>\n\n` +
            `Канал: ${channelName}\n` +
            `<i>Видео будет загружено автоматически.</i>`,
          new InlineKeyboard(),
        );
      } catch {}
    } else {
      await ctx.reply(
        `📺 Загрузка на YouTube (${channelName}) поставлена в очередь.`,
        { parse_mode: 'HTML' },
      );
    }
  }

  private buildChannelListText(channels: any[]): string {
    if (!channels.length) {
      return (
        '📺 <b>YouTube-каналы</b>\n\n' +
        '<i>Нет подключённых каналов.\n' +
        'Нажмите «Подключить», чтобы добавить YouTube-канал.</i>'
      );
    }

    const lines = channels.map((ch, i) => {
      const def = ch.isDefault ? ' ⭐' : '';
      return `${i + 1}. <b>${ch.channelTitle}</b>${def}`;
    });

    return '📺 <b>YouTube-каналы</b>\n\n' + lines.join('\n');
  }

  private buildChannelListKeyboard(channels: any[]): InlineKeyboard {
    const kb = new InlineKeyboard();

    for (const ch of channels) {
      const defLabel = ch.isDefault ? '⭐' : '☆';
      kb.text(
        `${defLabel} ${ch.channelTitle.slice(0, 20)}`,
        `yt:default:${ch.id}`,
      )
        .text('❌', `yt:remove:${ch.id}`)
        .row();
    }

    kb.text('➕ Подключить канал', 'yt:connect').row();
    kb.text('🏠 Главное меню', 'menu:back');

    return kb;
  }
}
