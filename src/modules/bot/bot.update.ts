import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { SessionsService } from '../sessions/sessions.service';
import { RenderSessionState } from '@prisma/client';
import { StorageService } from '../storage/storage.service';
import { TelegramFilesService } from '../telegram-files/telegram-files.service';
import { ProgressService } from '../redis/progress.service';
import { QueuesService } from '../queues/queues.service';
import { randomUUID } from 'node:crypto';

@Injectable()
export class BotUpdate {
  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly tgFiles: TelegramFilesService,
    private readonly queues: QueuesService,
    private readonly progress: ProgressService,
  ) {}

  register(bot: Bot) {
    // sessionId -> ожидаем следующий text как overlay comment
    const waitingComment = new Set<string>();

    bot.command('start', async (ctx) => {
      await ctx.reply('Hi! Use /new to start a new render session.');
    });

    bot.command('new', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.createNewSession(user.id);

      // на всякий: если новая сессия — не должен висеть режим comment
      waitingComment.delete(session.id);

      await ctx.reply('✅ New session created. Send me a video 🎬');
    });

    bot.command('status', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);

      if (!session) return ctx.reply('No active session. Use /new');

      // 1) пробуем взять быстрый статус из Redis
      const cachedStatus = await this.progress.getStatus(session.id);
      const cachedProgress = await this.progress.getProgress(session.id);
      const lastError = await this.progress.getLastError(session.id);

      // 2) если Redis ничего не знает — fallback на DB (как было)
      if (!cachedStatus && cachedProgress === null && !lastError) {
        const audioFallback = (session as any).originalAudioPolicy ?? 'KEEP';
        const overlayEnabledFallback = Boolean((session as any).overlayEnabled);
        const overlayCommentFallback = (session as any).overlayComment as
          | string
          | null
          | undefined;

        return ctx.reply(
          `State: ${session.state}\n` +
            `Video: ${session.sourceVideoKey ? 'uploaded' : 'not uploaded'}\n` +
            `Audio: ${audioFallback}\n` +
            `Comment: ${
              overlayEnabledFallback && overlayCommentFallback
                ? `"${overlayCommentFallback}"`
                : '(none)'
            }`,
        );
      }

      // 3) красивый вывод
      const lines: string[] = [];

      // Settings from DB
      const audio = (session as any).originalAudioPolicy ?? 'KEEP';
      lines.push(`Audio: ${audio}`);

      const overlayEnabled = Boolean((session as any).overlayEnabled);
      const overlayComment = (session as any).overlayComment as
        | string
        | null
        | undefined;

      if (overlayEnabled && overlayComment) {
        lines.push(`Comment: "${overlayComment}"`);
      } else {
        lines.push('Comment: (none)');
      }

      // State/progress from Redis
      const state = cachedStatus?.state ?? String(session.state);
      lines.push(`State: ${state}`);

      if (typeof cachedProgress === 'number') {
        lines.push(`Progress: ${cachedProgress}%`);
      }

      if (cachedStatus?.message) {
        lines.push(`Message: ${cachedStatus.message}`);
      }

      if (cachedStatus?.updatedAt) {
        lines.push(`Updated: ${cachedStatus.updatedAt}`);
      }

      lines.push(
        `Video: ${session.sourceVideoKey ? 'uploaded' : 'not uploaded'}`,
      );

      if (lastError) {
        lines.push(`Last error: ${lastError}`);
      }

      return ctx.reply(lines.join('\n'));
    });

    bot.on('message:video', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('Use /new first');

      // если пользователь прислал видео — сбрасываем режим ожидания комментария
      waitingComment.delete(session.id);

      if (
        session.state === RenderSessionState.RENDER_QUEUED ||
        session.state === RenderSessionState.RENDERING
      ) {
        return ctx.reply(
          '⏳ Rendering in progress. Send next video after it finishes.',
        );
      }

      const fileId = ctx.message.video.file_id;

      await ctx.reply('⬇️ Downloading video from Telegram...');
      await this.storage.ensureBucketExists();

      // 1) download stream from Telegram
      const { stream, filePath } =
        await this.tgFiles.downloadFileStream(fileId);

      // 2) choose key in MinIO
      const ext = filePath.includes('.') ? filePath.split('.').pop() : 'mp4';
      const key = `inputs/${session.id}/${randomUUID()}.${ext}`;

      // 3) upload to MinIO (важно: передаем ContentLength)
      const size = ctx.message.video.file_size;
      await this.storage.uploadStream(key, stream, 'video/mp4', size);

      // 4) persist in DB
      await this.sessions.setTelegramMeta(session.id, {
        videoFileId: fileId,
        tgFilePath: filePath,
      });
      await this.sessions.setSourceVideoKey(session.id, key);

      // При новом видео логично сбросить старый overlay comment, чтобы не удивлять пользователя
      // (Если хочешь сохранять — просто убери эту строку)
      await this.sessions.setOverlayComment(session.id, null);

      await this.sessions.setState(
        session.id,
        RenderSessionState.WAIT_TEXT_OR_SETTINGS,
      );

      // Берём актуальные настройки для вывода в "Video uploaded..."
      const refreshed = await this.sessions.getActiveSession(user.id);
      const audio = (refreshed as any)?.originalAudioPolicy ?? 'KEEP';
      const overlayEnabled = Boolean((refreshed as any)?.overlayEnabled);
      const overlayComment = (refreshed as any)?.overlayComment as
        | string
        | null
        | undefined;

      const settingsLines = [
        `Audio: ${audio}`,
        overlayEnabled && overlayComment
          ? `Comment: "${overlayComment}"`
          : 'Comment: (none)',
      ];

      const kb = new InlineKeyboard()
        .text('💬 Add Comment', 'render:comment')
        .row()
        .text('🔊 Keep Audio', 'render:audio:keep')
        .text('🔇 Mute Audio', 'render:audio:mute')
        .row()
        .text('✅ Approve & Render', 'render:approve')
        .row()
        .text('❌ Cancel', 'render:cancel');

      await ctx.reply(
        `✅ Video uploaded to storage.\n` +
          `Key: ${key}\n\n` +
          `Current settings:\n` +
          `${settingsLines.join('\n')}\n\n` +
          `Next: Add Comment / Audio policy, then Approve & Render`,
        {
          reply_markup: kb,
        },
      );
    });

    bot.callbackQuery('render:comment', async (ctx) => {
      await ctx.answerCallbackQuery();

      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);
      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');

      if (!session.sourceVideoKey) return ctx.reply('Send a video first.');

      if (
        session.state === RenderSessionState.RENDER_QUEUED ||
        session.state === RenderSessionState.RENDERING
      ) {
        return ctx.reply(
          '⏳ Rendering in progress. You can add comment for the next video.',
        );
      }

      waitingComment.add(session.id);
      await ctx.reply(
        '✍️ Send the comment text (next message). It will be burned into the video.',
      );
    });

    bot.callbackQuery('render:audio:keep', async (ctx) => {
      await ctx.answerCallbackQuery();

      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);
      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');

      await this.sessions.setOriginalAudioPolicy(session.id, 'KEEP');
      await ctx.reply('✅ Audio policy set: KEEP');
    });

    bot.callbackQuery('render:audio:mute', async (ctx) => {
      await ctx.answerCallbackQuery();

      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);
      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');

      await this.sessions.setOriginalAudioPolicy(session.id, 'MUTE');
      await ctx.reply('✅ Audio policy set: MUTE');
    });

    bot.on('message:text', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return;

      if (!waitingComment.has(session.id)) return;

      const text = (ctx.message.text || '').trim();
      if (!text) return ctx.reply('Empty comment. Send text or /new to reset.');

      // MVP ограничение — чтобы drawtext не сломался
      const safe = text.slice(0, 200);

      await this.sessions.setOverlayComment(session.id, safe);

      waitingComment.delete(session.id);

      const kb = new InlineKeyboard()
        .text('✅ Approve & Render', 'render:approve')
        .row()
        .text('❌ Cancel', 'render:cancel');

      await ctx.reply(`✅ Comment saved.\n\nNow press "Approve & Render".`, {
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

      if (!session.sourceVideoKey) {
        return ctx.reply('No video uploaded yet. Send a video first.');
      }

      // state -> queued
      await this.sessions.setState(
        session.id,
        RenderSessionState.RENDER_QUEUED,
      );

      await this.progress.setStatus(session.id, {
        state: 'RENDER_QUEUED',
        updatedAt: new Date().toISOString(),
        message: 'Queued',
      });
      await this.progress.setProgress(session.id, 0);

      // enqueue BullMQ render job (jobId=sessionId)
      const job = await this.queues.enqueueRender({
        sessionId: session.id,
        userId: user.id,
        chatId: String(ctx.chat?.id),
      });

      // после approve больше не ждём комментарий
      waitingComment.delete(session.id);

      await ctx.reply(
        `✅ Enqueued. jobId=${job.id}\nUse /status to track progress.`,
      );
    });

    bot.callbackQuery('render:cancel', async (ctx) => {
      await ctx.answerCallbackQuery();

      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);
      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);

      const newSession = await this.sessions.createNewSession(user.id);
      waitingComment.delete(newSession.id);

      await ctx.reply('❌ Cancelled. New session started. Send a video 🎬');
    });
  }
}
