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
    const waitingTtsText = new Set<string>();

    const TG_LIMIT = 4096;
    const SAFE_CHUNK = 3500;

    const clip = (s: any, max = 900) => {
      const str = String(s ?? '');
      if (str.length <= max) return str;
      // полезнее показывать хвост для ffmpeg ошибок
      const tail = str.slice(-max);
      return `…(truncated, last ${max} chars)\n${tail}`;
    };

    const replyLong = async (ctx: any, text: string) => {
      const chunks: string[] = [];
      let rest = text;

      while (rest.length > SAFE_CHUNK) {
        // пытаемся резать по \n чтобы не ломать строки
        let cut = rest.lastIndexOf('\n', SAFE_CHUNK);
        if (cut < 1000) cut = SAFE_CHUNK;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest.trim().length) chunks.push(rest);

      for (const c of chunks) {
        // если вдруг всё равно больше лимита — подстрахуемся
        const safe =
          c.length > TG_LIMIT ? c.slice(0, TG_LIMIT - 50) + '\n…' : c;
        await ctx.reply(safe);
      }
    };

    bot.command('start', async (ctx) => {
      await ctx.reply('Hi! Use /new to start a new render session.');
    });

    bot.command('new', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.createNewSession(user.id);

      // на всякий: если новая сессия — не должен висеть режим comment/tts text
      waitingComment.delete(session.id);
      waitingTtsText.delete(session.id);

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

      // 2) если Redis ничего не знает — fallback на DB
      if (!cachedStatus && cachedProgress === null && !lastError) {
        const audioFallback = (session as any).originalAudioPolicy ?? 'KEEP';

        const overlayEnabledFallback = Boolean((session as any).overlayEnabled);
        const overlayCommentFallback = (session as any).overlayComment as
          | string
          | null
          | undefined;

        const ttsEnabledFallback = Boolean((session as any).ttsEnabled);
        const subsFallback = (session as any).subtitlesMode ?? 'NONE';
        const ttsTextFallback = (session as any).ttsText ? '(set)' : '(none)';

        const msg =
          `Audio: ${audioFallback}\n` +
          `TTS: ${ttsEnabledFallback ? 'ON' : 'OFF'}\n` +
          `Subs: ${subsFallback}\n` +
          `TTS text: ${ttsTextFallback}\n` +
          `Comment: ${
            overlayEnabledFallback && overlayCommentFallback
              ? `"${overlayCommentFallback}"`
              : '(none)'
          }\n` +
          `State: ${session.state}\n` +
          `Video: ${session.sourceVideoKey ? 'uploaded' : 'not uploaded'}`;

        return replyLong(ctx, msg);
      }

      // 3) красивый вывод
      const lines: string[] = [];

      // Settings from DB
      const audio = (session as any).originalAudioPolicy ?? 'KEEP';
      lines.push(`Audio: ${audio}`);

      const ttsEnabled = Boolean((session as any).ttsEnabled);
      const subs = (session as any).subtitlesMode ?? 'NONE';
      const ttsText = (session as any).ttsText ? '(set)' : '(none)';
      lines.push(`TTS: ${ttsEnabled ? 'ON' : 'OFF'}`);
      lines.push(`Subs: ${subs}`);
      lines.push(`TTS text: ${ttsText}`);

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
        lines.push(`Message: ${clip(cachedStatus.message, 1200)}`);
      }

      if (cachedStatus?.updatedAt) {
        lines.push(`Updated: ${cachedStatus.updatedAt}`);
      }

      lines.push(
        `Video: ${session.sourceVideoKey ? 'uploaded' : 'not uploaded'}`,
      );

      if (lastError) {
        lines.push(`Last error: ${clip(lastError, 1200)}`);
      }

      return replyLong(ctx, lines.join('\n'));
    });

    bot.on('message:video', async (ctx) => {
      const tgUserId = String(ctx.from?.id);
      const chatId = String(ctx.chat?.id);

      const user = await this.sessions.getOrCreateUser(tgUserId, chatId);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('Use /new first');

      // если пользователь прислал видео — сбрасываем режим ожидания
      waitingComment.delete(session.id);
      waitingTtsText.delete(session.id);

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

      // при новом видео логично сбросить старый overlay comment
      await this.sessions.setOverlayComment(session.id, null);

      await this.sessions.setState(
        session.id,
        RenderSessionState.WAIT_TEXT_OR_SETTINGS,
      );

      // Берём актуальные настройки для вывода
      const refreshed = await this.sessions.getActiveSession(user.id);
      const audio = (refreshed as any)?.originalAudioPolicy ?? 'KEEP';
      const overlayEnabled = Boolean((refreshed as any)?.overlayEnabled);
      const overlayComment = (refreshed as any)?.overlayComment as
        | string
        | null
        | undefined;

      const ttsEnabled = Boolean((refreshed as any)?.ttsEnabled);
      const subs = (refreshed as any)?.subtitlesMode ?? 'NONE';

      const settingsLines = [
        `Audio: ${audio}`,
        `TTS: ${ttsEnabled ? 'ON' : 'OFF'}`,
        `Subs: ${subs}`,
        overlayEnabled && overlayComment
          ? `Comment: "${overlayComment}"`
          : 'Comment: (none)',
      ];

      const kb = new InlineKeyboard()
        .text(ttsEnabled ? '🗣 TTS: ON' : '🗣 TTS: OFF', 'render:tts:toggle')
        .text('✍️ Set TTS Text', 'render:tts:text')
        .row()
        .text(`🎞 Subs: ${subs}`, 'render:subs:toggle')
        .row()
        .text(`💬 Add Comment`, 'render:comment')
        .row()
        .text('🔁 Replace', 'render:audio:replace')
        .text('🦆 Duck', 'render:audio:duck')
        .row()
        .text('🔇 Mute', 'render:audio:mute')
        .text('🔊 Keep', 'render:audio:keep')
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

    bot.callbackQuery('render:tts:toggle', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');

      const enabled = !Boolean((session as any).ttsEnabled);
      await this.sessions.setTtsEnabled(session.id, enabled);

      // если выключили TTS — логично сбросить subs в NONE
      if (!enabled) await this.sessions.setSubtitlesMode(session.id, 'NONE');

      await ctx.reply(`✅ TTS: ${enabled ? 'ON' : 'OFF'}`);
    });

    bot.callbackQuery('render:tts:text', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');
      if (!session.sourceVideoKey) return ctx.reply('Send a video first.');

      waitingTtsText.add(session.id);
      await ctx.reply('✍️ Send the TTS text (next message).');
    });

    bot.callbackQuery('render:subs:toggle', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');

      const ttsEnabled = Boolean((session as any).ttsEnabled);
      if (!ttsEnabled)
        return ctx.reply('⚠️ Subtitles available only when TTS is ON.');

      const cur = (session as any).subtitlesMode ?? 'NONE';
      const next = cur === 'HARD' ? 'NONE' : 'HARD';
      await this.sessions.setSubtitlesMode(session.id, next);

      await ctx.reply(`✅ Subtitles: ${next}`);
    });

    bot.callbackQuery('render:audio:replace', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');
      await this.sessions.setOriginalAudioPolicy(session.id, 'REPLACE');
      await ctx.reply('✅ Audio policy set: REPLACE');
    });

    bot.callbackQuery('render:audio:duck', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('No active session. Use /new');
      await this.sessions.setOriginalAudioPolicy(session.id, 'DUCK');
      await ctx.reply('✅ Audio policy set: DUCK');
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

      if (waitingTtsText.has(session.id)) {
        const text = (ctx.message.text || '').trim();
        if (!text) return ctx.reply('Empty TTS text. Send again.');

        await this.sessions.setTtsEnabled(session.id, true);
        await this.sessions.setTtsText(session.id, text.slice(0, 4000));
        waitingTtsText.delete(session.id);

        return ctx.reply('✅ TTS text saved.');
      }

      if (!waitingComment.has(session.id)) return;

      const text = (ctx.message.text || '').trim();
      if (!text) return ctx.reply('Empty comment. Send text or /new to reset.');

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

      const job = await this.queues.enqueueRender({
        sessionId: session.id,
        userId: user.id,
        chatId: String(ctx.chat?.id),
      });

      waitingComment.delete(session.id);
      waitingTtsText.delete(session.id);

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
      waitingTtsText.delete(newSession.id);

      await ctx.reply('❌ Cancelled. New session started. Send a video 🎬');
    });
  }
}
