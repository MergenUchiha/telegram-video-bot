import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { SessionsService } from '../sessions/sessions.service';
import { RenderSessionState } from '@prisma/client';

@Injectable()
export class BotUpdate {
  constructor(private readonly sessions: SessionsService) {}

  register(bot: Bot) {
    bot.command('start', async (ctx) => {
      await ctx.reply('Hi! Use /new to start a new render session.');
    });

    bot.command('new', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      await this.sessions.createNewSession(user.id);

      await ctx.reply('✅ New session created. Send me a video 🎬');
    });

    bot.command('status', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);

      if (!session) return ctx.reply('No active session. Use /new');

      await ctx.reply(
        `State: ${session.state}\n` +
        `Video: ${session.sourceVideoKey ? 'uploaded' : 'not uploaded'}`
      );
    });

    bot.on('message:video', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);

      if (!session) return ctx.reply('Use /new first');

      if (
        session.state === RenderSessionState.RENDER_QUEUED ||
        session.state === RenderSessionState.RENDERING
      ) {
        return ctx.reply('⏳ Rendering in progress. Send next video after it finishes.');
      }

      // MVP: сохраняем только file_id в telegramMeta (позже: скачать и залить в MinIO)
      const fileId = ctx.message.video.file_id;

      await this.sessions.setTelegramMeta(session.id, { videoFileId: fileId });
      await this.sessions.setState(session.id, RenderSessionState.WAIT_TEXT_OR_SETTINGS);

      const kb = new InlineKeyboard()
        .text('✅ Approve & Render', 'render:approve')
        .row()
        .text('❌ Cancel', 'render:cancel');

      await ctx.reply(`✅ Video received.\nfile_id: ${fileId}\n\nNext step: Approve & Render`, {
        reply_markup: kb,
      });
    });

    bot.callbackQuery('render:approve', async (ctx) => {
      await ctx.answerCallbackQuery();

      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);
      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);

      if (!session) return ctx.reply('No active session. Use /new');

      // Пока без очереди/воркера — просто отметим что "готово к рендеру"
      await this.sessions.setState(session.id, RenderSessionState.READY_TO_RENDER);
      await ctx.reply('✅ Approved. Next: we will enqueue BullMQ render job (next step).');
    });

    bot.callbackQuery('render:cancel', async (ctx) => {
      await ctx.answerCallbackQuery();
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);
      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      await this.sessions.createNewSession(user.id);
      await ctx.reply('❌ Cancelled. New session started. Send a video 🎬');
    });
  }
}