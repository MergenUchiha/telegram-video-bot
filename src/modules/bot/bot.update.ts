import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { SessionsService } from '../sessions/sessions.service';
import { ContentMode, RenderSessionState } from '@prisma/client';
import { StorageService } from '../storage/storage.service';
import { TelegramFilesService } from '../telegram-files/telegram-files.service';
import { ProgressService } from '../redis/progress.service';
import { QueuesService } from '../queues/queues.service';
import { RateLimitService } from './rate-limit.service';
import { BackgroundLibraryService } from '../library/background-library.service';
import { MusicLibraryService } from '../library/music-library.service';
import { JokesCacheService } from '../jokes/jokes-cache.service';
import { UsedJokesService } from '../jokes/used-jokes.service';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

// Что ждём от следующего текстового сообщения пользователя
type WaitType =
  | 'comment'
  | 'tts_text'
  | 'language'
  | 'voice'
  | 'speed'
  | 'duck_level';
interface WaitState {
  type: WaitType;
  panelMsgId: number;
}

// Пресеты карточки анекдота
const PRESETS = ['default', 'dark', 'light', 'minimal'] as const;

@Injectable()
export class BotUpdate {
  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly tgFiles: TelegramFilesService,
    private readonly queues: QueuesService,
    private readonly progress: ProgressService,
    private readonly rateLimit: RateLimitService,
    private readonly bgLibrary: BackgroundLibraryService,
    private readonly musicLibrary: MusicLibraryService,
    private readonly jokesCache: JokesCacheService,
    private readonly usedJokes: UsedJokesService,
  ) {}

  register(bot: Bot): void {
    // Состояние ожидания текста — per-session
    const waiting = new Map<string, WaitState>();

    // ─────────────────────────────────────────────────────────────────────────
    // Команды бота
    // ─────────────────────────────────────────────────────────────────────────
    void bot.api.setMyCommands([
      { command: 'start', description: '🏠 Главное меню' },
      { command: 'status', description: '📊 Статус рендера' },
    ]);

    // ─────────────────────────────────────────────────────────────────────────
    // Rate limit middleware
    // ─────────────────────────────────────────────────────────────────────────
    bot.use(async (ctx, next) => {
      const uid = String(ctx.from?.id ?? 'unknown');
      const rl = await this.rateLimit.check(uid);
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

    // ─────────────────────────────────────────────────────────────────────────
    // Хелперы
    // ─────────────────────────────────────────────────────────────────────────
    const getUser = (ctx: any) =>
      this.sessions.getOrCreateUser(String(ctx.from?.id), String(ctx.chat?.id));

    const chatId = (ctx: any): string => String(ctx.chat?.id ?? ctx.from?.id);

    const tryDelete = async (ctx: any, msgId: number | null | undefined) => {
      if (!msgId) return;
      try {
        await ctx.api.deleteMessage(chatId(ctx), msgId);
      } catch {}
    };

    // Редактировать панель (или отправить новую если что-то пошло не так)
    const editPanel = async (
      ctx: any,
      msgId: number,
      text: string,
      kb: InlineKeyboard,
    ): Promise<number> => {
      try {
        await ctx.api.editMessageText(chatId(ctx), msgId, text, {
          reply_markup: kb,
          parse_mode: 'HTML',
        });
        return msgId;
      } catch {
        const m = await ctx.api.sendMessage(chatId(ctx), text, {
          reply_markup: kb,
          parse_mode: 'HTML',
        });
        return m.message_id;
      }
    };

    // Отправить новое сообщение и сохранить его ID как панель сессии
    const sendPanel = async (
      ctx: any,
      sessionId: string | null,
      text: string,
      kb: InlineKeyboard,
    ): Promise<number> => {
      const m = await ctx.api.sendMessage(chatId(ctx), text, {
        reply_markup: kb,
        parse_mode: 'HTML',
      });
      if (sessionId) {
        await this.sessions.setLastBotMessageId(sessionId, m.message_id);
      }
      return m.message_id;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Главное меню
    // ─────────────────────────────────────────────────────────────────────────
    const MAIN_MENU_TEXT =
      '🎬 <b>Что делаем?</b>\n\n' +
      '• <b>Spanish Jokes Auto</b> — бот сам возьмёт анекдот, фон и музыку, сделает ролик\n' +
      '• <b>Стандартный рендер</b> — ты отправляешь видео, настраиваешь TTS / субтитры / звук';

    const mainMenuKeyboard = () =>
      new InlineKeyboard()
        .text('🎭 Spanish Jokes Auto', 'menu:jokes')
        .row()
        .text('🎬 Стандартный рендер', 'menu:standard');

    const showMainMenu = async (ctx: any): Promise<void> => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);

      // Если идёт рендер — не сбрасываем, предупреждаем
      if (session) {
        const busy =
          session.state === RenderSessionState.RENDER_QUEUED ||
          session.state === RenderSessionState.RENDERING;
        if (busy) {
          const prog = await this.progress.getProgress(session.id);
          const status = await this.progress.getStatus(session.id);
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
        waiting.delete(session.id);
      }

      await sendPanel(ctx, null, MAIN_MENU_TEXT, mainMenuKeyboard());
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Текст настроек стандартного режима
    // ─────────────────────────────────────────────────────────────────────────
    const standardPanelText = (session: any): string => {
      const hasVideo = Boolean(session.sourceVideoKey);
      const tts = Boolean(session.ttsEnabled);
      const subs = String(session.subtitlesMode ?? 'NONE');
      const audio = String(session.originalAudioPolicy ?? 'DUCK');
      const duckDb = session.customDuckDb != null ? session.customDuckDb : -18;
      const comment = session.overlayComment as string | null;

      if (!hasVideo) {
        return (
          '🎬 <b>Стандартный рендер</b>\n\n' +
          '📎 Отправь видео в этот чат, чтобы начать\n\n' +
          '<i>Поддерживается видео до 200 МБ. После загрузки появятся настройки обработки.</i>'
        );
      }

      const audioLabel: Record<string, string> = {
        REPLACE: 'Replace — заменить на TTS',
        DUCK: `Duck — приглушить на ${duckDb} dB`,
        MUTE: 'Mute — убрать звук',
        KEEP: 'Keep — оставить оригинал',
      };

      const lines = [
        '🎬 <b>Стандартный рендер</b> — настройки\n',
        `🎥 Видео: ✅`,
        `🔊 Звук: ${audioLabel[audio] ?? audio}`,
        `🗣 TTS: ${tts ? '✅ включён' : '○ выключен'}`,
      ];
      if (tts) {
        lines.push(
          `   • Язык: ${session.language ?? 'auto'}  |  Голос: ${session.voiceId ?? 'default'}  |  Скорость: ${session.ttsSpeed != null ? session.ttsSpeed + 'x' : '1.0x'}`,
          `   • Субтитры: ${subs}`,
        );
      }
      lines.push(
        `💬 Комментарий: ${comment ? `"${comment.slice(0, 60)}${comment.length > 60 ? '…' : ''}"` : '○ нет'}`,
      );
      if (Boolean(session.advancedKeepWithTts)) {
        lines.push(`\n⚠️ Advanced: KEEP+TTS`);
      }
      return lines.join('\n');
    };

    const standardPanelKeyboard = (session: any): InlineKeyboard => {
      const tts = Boolean(session.ttsEnabled);
      const subs = String(session.subtitlesMode ?? 'NONE');
      const audio = String(session.originalAudioPolicy ?? 'DUCK');
      const hasVideo = Boolean(session.sourceVideoKey);

      const mark = (cond: boolean) => (cond ? ' ✓' : '');
      const kb = new InlineKeyboard();

      if (!hasVideo) {
        kb.text('🏠 Главное меню', 'menu:back');
        return kb;
      }

      // TTS + субтитры
      kb.text(`🗣 TTS: ${tts ? 'ВКЛ ✓' : 'ВЫКЛ'}`, 's:tts_toggle').row();
      if (tts) {
        kb.text('✍️ Текст для TTS', 's:tts_text').row();
        kb.text('🌐 Язык', 's:language')
          .text('🎙 Голос', 's:voice')
          .text('⚡ Скорость', 's:speed')
          .row();
        kb.text(
          `📝 Субтитры: ${subs}${mark(subs === 'HARD')}`,
          's:subs_toggle',
        ).row();
      }

      // Комментарий
      kb.text('💬 Комментарий', 's:comment').row();

      // Звук
      kb.text(`Replace${mark(audio === 'REPLACE')}`, 's:audio:REPLACE')
        .text(`Duck${mark(audio === 'DUCK')}`, 's:audio:DUCK')
        .row();
      kb.text(`Mute${mark(audio === 'MUTE')}`, 's:audio:MUTE')
        .text(`Keep${mark(audio === 'KEEP')}`, 's:audio:KEEP')
        .row();

      // Advanced + действия
      kb.text('⚙️ Advanced', 's:advanced').row();
      kb.text('▶️ Рендерить!', 'do:approve').row();
      kb.text('🏠 Главное меню', 'menu:back');
      return kb;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Текст и клавиатура Auto режима
    // ─────────────────────────────────────────────────────────────────────────
    const autoPanelText = (session: any): string => {
      const autoPublish = Boolean(session.autoPublishYoutube);
      const preset = session.textCardPreset ?? 'default';
      const bgFixed = session.fixedBackgroundVideoKey as string | null;
      const musicFixed = session.fixedBackgroundMusicKey as string | null;

      const videoLabel = bgFixed
        ? `📌 ${path.basename(bgFixed)}`
        : '🎲 Случайное из библиотеки';
      const musicLabel = musicFixed
        ? `📌 ${path.basename(musicFixed)}`
        : '🎲 Случайная из библиотеки';

      return (
        '🎭 <b>Spanish Jokes Auto</b> — настройки\n\n' +
        `🎬 Фон: ${videoLabel}\n` +
        `🎵 Музыка: ${musicLabel}\n` +
        `🃏 Стиль карточки: ${preset}\n` +
        `📺 Авто-YouTube: ${autoPublish ? '✅ включён' : '○ выключен'}\n\n` +
        '<i>Всё остальное — анекдот, сборка видео — бот сделает автоматически.</i>'
      );
    };

    const autoPanelKeyboard = (session: any): InlineKeyboard => {
      const autoPublish = Boolean(session.autoPublishYoutube);
      const bgFixed = session.fixedBackgroundVideoKey as string | null;
      const musicFixed = session.fixedBackgroundMusicKey as string | null;

      return new InlineKeyboard()
        .text(
          bgFixed ? '🎬 Фон: выбран ✓' : '🎬 Выбрать фоновое видео',
          'auto:pick_video',
        )
        .row()
        .text(
          musicFixed ? '🎵 Музыка: выбрана ✓' : '🎵 Выбрать музыку',
          'auto:pick_music',
        )
        .row()
        .text('🃏 Стиль карточки', 'auto:preset_cycle')
        .text('📊 Анекдоты', 'auto:jokes_status')
        .row()
        .text(
          autoPublish ? '📺 Авто-YouTube: ВКЛ ✓' : '📺 Авто-YouTube',
          'auto:toggle_youtube',
        )
        .row()
        .text('▶️ Запустить!', 'do:approve')
        .row()
        .text('🏠 Главное меню', 'menu:back');
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Обновить панель настроек текущей сессии (редактирует то же сообщение)
    // ─────────────────────────────────────────────────────────────────────────
    const refreshPanel = async (
      ctx: any,
      session: any,
      panelMsgId?: number,
    ) => {
      const msgId = panelMsgId ?? session.lastBotMessageId;
      if (!msgId) return;

      const isAuto = session.contentMode === ContentMode.SPANISH_JOKES_AUTO;
      const text = isAuto ? autoPanelText(session) : standardPanelText(session);
      const kb = isAuto
        ? autoPanelKeyboard(session)
        : standardPanelKeyboard(session);

      const newId = await editPanel(ctx, msgId, text, kb);
      if (newId !== msgId) {
        await this.sessions.setLastBotMessageId(session.id, newId);
      }
    };

    // Получить актуальную сессию и вызвать refreshPanel через callback
    const cbRefresh = async (ctx: any, toast?: string) => {
      await ctx.answerCallbackQuery(toast ? { text: toast } : {});
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      const fresh = await this.sessions.getSessionById(session.id);
      await refreshPanel(ctx, fresh, msgId);
    };

    const cbGetSession = async (ctx: any) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      return { user, session };
    };

    // ─────────────────────────────────────────────────────────────────────────
    // /start — главное меню
    // ─────────────────────────────────────────────────────────────────────────
    bot.command('start', async (ctx) => {
      await showMainMenu(ctx);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // /status — быстрый статус текстом (не трогает панель)
    // ─────────────────────────────────────────────────────────────────────────
    bot.command('status', async (ctx) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('Нет активной сессии. Нажми /start.');

      const cachedStatus = await this.progress.getStatus(session.id);
      const prog = await this.progress.getProgress(session.id);
      const lastError = await this.progress.getLastError(session.id);

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

    // ─────────────────────────────────────────────────────────────────────────
    // Кнопки главного меню
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('menu:back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { user, session } = await cbGetSession(ctx);
      if (session) waiting.delete(session.id);

      const msgId = ctx.callbackQuery?.message?.message_id as number;
      const newId = await editPanel(
        ctx,
        msgId,
        MAIN_MENU_TEXT,
        mainMenuKeyboard(),
      );
      // Сбрасываем lastBotMessageId сессии чтобы новая сессия открылась свежо
      if (session && newId !== session.lastBotMessageId) {
        await this.sessions.setLastBotMessageId(session.id, null);
      }
    });

    bot.callbackQuery('menu:jokes', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await getUser(ctx);
      const existingSession = await this.sessions.getActiveSession(user.id);

      if (existingSession) {
        const busy =
          existingSession.state === RenderSessionState.RENDER_QUEUED ||
          existingSession.state === RenderSessionState.RENDERING;
        if (busy) {
          return ctx.answerCallbackQuery({
            text: '⏳ Сейчас идёт рендер. Дождись завершения.',
            show_alert: true,
          });
        }
        waiting.delete(existingSession.id);
      }

      const session = await this.sessions.createSpanishJokesSession(user.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      const text = autoPanelText(session);
      const kb = autoPanelKeyboard(session);
      const newId = await editPanel(ctx, msgId, text, kb);
      await this.sessions.setLastBotMessageId(session.id, newId);
    });

    bot.callbackQuery('menu:standard', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await getUser(ctx);
      const existingSession = await this.sessions.getActiveSession(user.id);

      if (existingSession) {
        const busy =
          existingSession.state === RenderSessionState.RENDER_QUEUED ||
          existingSession.state === RenderSessionState.RENDERING;
        if (busy) {
          return ctx.answerCallbackQuery({
            text: '⏳ Сейчас идёт рендер. Дождись завершения.',
            show_alert: true,
          });
        }
        waiting.delete(existingSession.id);
      }

      const session = await this.sessions.createNewSession(user.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      const text = standardPanelText(session); // покажет "отправь видео"
      const kb = standardPanelKeyboard(session);
      const newId = await editPanel(ctx, msgId, text, kb);
      await this.sessions.setLastBotMessageId(session.id, newId);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Обновление статуса (кнопка в сообщении о занятом рендере)
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('status:refresh', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      const prog = await this.progress.getProgress(session.id);
      const status = await this.progress.getStatus(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;

      const busy =
        session.state === RenderSessionState.RENDER_QUEUED ||
        session.state === RenderSessionState.RENDERING;

      if (!busy) {
        await ctx.answerCallbackQuery({ text: '✅ Рендер завершён' });
        try {
          await ctx.api.editMessageText(chatId(ctx), msgId, MAIN_MENU_TEXT, {
            reply_markup: mainMenuKeyboard(),
            parse_mode: 'HTML',
          });
        } catch {}
        return;
      }

      const text =
        '⏳ <b>Рендер выполняется</b>\n\n' +
        `Прогресс: ${prog ?? 0}%\n` +
        (status?.message ? `Статус: ${status.message}` : '');

      await ctx.answerCallbackQuery({ text: `${prog ?? 0}%` });
      try {
        await ctx.api.editMessageText(chatId(ctx), msgId, text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '🔄 Обновить статус',
            'status:refresh',
          ),
        });
      } catch {}
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Приём видео
    // ─────────────────────────────────────────────────────────────────────────
    bot.on('message:video', async (ctx) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);

      if (!session) {
        await tryDelete(ctx, ctx.message.message_id);
        return ctx.reply('Нажми /start, чтобы выбрать режим.', {
          parse_mode: 'HTML',
        });
      }

      if (
        session.state === RenderSessionState.RENDER_QUEUED ||
        session.state === RenderSessionState.RENDERING
      ) {
        await tryDelete(ctx, ctx.message.message_id);
        return ctx.reply(
          '⏳ Рендер выполняется. Отправь видео после завершения.',
        );
      }

      if (session.contentMode === ContentMode.SPANISH_JOKES_AUTO) {
        await tryDelete(ctx, ctx.message.message_id);
        return; // Auto-режиму видео не нужно
      }

      // Удаляем сообщение пользователя с видео (чисто в чате)
      await tryDelete(ctx, ctx.message.message_id);

      const panelMsgId = session.lastBotMessageId;

      // Показываем "загружаю" в панели
      if (panelMsgId) {
        await editPanel(
          ctx,
          panelMsgId,
          '⬇️ <b>Загружаю видео...</b>',
          new InlineKeyboard(),
        );
      }

      try {
        await this.storage.ensureBucketExists();
        const { stream, filePath } = await this.tgFiles.downloadFileStream(
          ctx.message.video.file_id,
        );
        const ext = filePath.includes('.') ? filePath.split('.').pop() : 'mp4';
        const key = `inputs/${session.id}/${randomUUID()}.${ext}`;
        await this.storage.uploadStream(
          key,
          stream,
          'video/mp4',
          ctx.message.video.file_size,
        );

        await this.sessions.setTelegramMeta(session.id, {
          videoFileId: ctx.message.video.file_id,
          tgFilePath: filePath,
        });
        await this.sessions.setSourceVideoKey(session.id, key);
        await this.sessions.setOverlayComment(session.id, null);
        await this.sessions.setState(
          session.id,
          RenderSessionState.WAIT_TEXT_OR_SETTINGS,
        );

        const fresh = await this.sessions.getSessionById(session.id);
        const text = standardPanelText(fresh);
        const kb = standardPanelKeyboard(fresh);

        if (panelMsgId) {
          const newId = await editPanel(ctx, panelMsgId, text, kb);
          if (newId !== panelMsgId) {
            await this.sessions.setLastBotMessageId(session.id, newId);
          }
        } else {
          await sendPanel(ctx, session.id, text, kb);
        }
      } catch (e: any) {
        const errText = `❌ <b>Ошибка загрузки видео</b>\n\n${String(e?.message).slice(0, 400)}`;
        if (panelMsgId) {
          await editPanel(
            ctx,
            panelMsgId,
            errText,
            new InlineKeyboard().text('🏠 Главное меню', 'menu:back'),
          );
        } else {
          await ctx.reply(errText, { parse_mode: 'HTML' });
        }
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Настройки стандартного режима — TTS
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('s:tts_toggle', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session)
        return ctx.answerCallbackQuery({ text: 'Нет сессии. /start' });
      const enabled = !Boolean(session.ttsEnabled);
      await this.sessions.setTtsEnabled(session.id, enabled);
      if (!enabled) await this.sessions.setSubtitlesMode(session.id, 'NONE');
      await cbRefresh(ctx, `TTS: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
    });

    bot.callbackQuery('s:subs_toggle', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      if (!session.ttsEnabled) {
        return ctx.answerCallbackQuery({
          text: '⚠️ Субтитры доступны только при включённом TTS',
          show_alert: true,
        });
      }
      const cur = String(session.subtitlesMode ?? 'NONE');
      await this.sessions.setSubtitlesMode(
        session.id,
        cur === 'HARD' ? 'NONE' : 'HARD',
      );
      await cbRefresh(ctx, `Субтитры: ${cur === 'HARD' ? 'NONE' : 'HARD'}`);
    });

    // Запрос текстового ввода — показываем промпт ниже и ждём
    const askText = async (ctx: any, type: WaitType, prompt: string) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const panelMsgId = ctx.callbackQuery?.message?.message_id as number;
      waiting.set(session.id, { type, panelMsgId });
      await ctx.reply(prompt, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text(
          '✕ Отмена',
          `cancel_input:${session.id}`,
        ),
      });
    };

    bot.callbackQuery('s:tts_text', (ctx) =>
      askText(
        ctx,
        'tts_text',
        '✍️ <b>Текст для TTS</b>\n\nОтправь текст, который озвучить:',
      ),
    );

    bot.callbackQuery('s:language', (ctx) =>
      askText(
        ctx,
        'language',
        '🌐 <b>Язык TTS</b>\n\nОтправь код языка: <code>ru</code>, <code>en</code>, <code>es</code>, <code>de</code>, <code>fr</code>, <code>ja</code>, <code>zh</code>\nИли <code>auto</code> для автоопределения',
      ),
    );

    bot.callbackQuery('s:voice', (ctx) =>
      askText(
        ctx,
        'voice',
        '🎙 <b>Голос Kokoro</b>\n\nОтправь ID голоса:\n<code>af_heart</code>  <code>af_bella</code>  <code>am_michael</code>  <code>bf_emma</code>\nИли <code>default</code> для стандартного',
      ),
    );

    bot.callbackQuery('s:speed', (ctx) =>
      askText(
        ctx,
        'speed',
        '⚡ <b>Скорость TTS</b>\n\nОтправь число от <code>0.5</code> до <code>2.0</code>\nПример: <code>1.2</code>\nОставь <code>1.0</code> для стандартной скорости',
      ),
    );

    bot.callbackQuery('s:comment', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session?.sourceVideoKey) {
        return ctx.answerCallbackQuery({
          text: '❌ Сначала загрузи видео',
          show_alert: true,
        });
      }
      await askText(
        ctx,
        'comment',
        '💬 <b>Комментарий на видео</b>\n\nОтправь текст — он появится внизу видео:',
      );
    });

    // Отмена ввода
    bot.callbackQuery(/^cancel_input:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      const sessionId = ctx.match[1];
      waiting.delete(sessionId);
      try {
        await ctx.deleteMessage();
      } catch {}
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Настройки звука
    // ─────────────────────────────────────────────────────────────────────────
    for (const policy of ['REPLACE', 'DUCK', 'MUTE', 'KEEP'] as const) {
      bot.callbackQuery(`s:audio:${policy}`, async (ctx) => {
        const { session } = await cbGetSession(ctx);
        if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
        await this.sessions.setOriginalAudioPolicy(session.id, policy);
        await cbRefresh(ctx, `Звук: ${policy}`);
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Advanced
    // ─────────────────────────────────────────────────────────────────────────
    const advancedText = (session: any): string => {
      const keepWithTts = Boolean(session.advancedKeepWithTts);
      const duckDb = session.customDuckDb != null ? session.customDuckDb : -18;
      return (
        '⚙️ <b>Advanced настройки</b>\n\n' +
        `<b>KEEP+TTS:</b> ${keepWithTts ? 'ВКЛ ✓' : 'ВЫКЛ'}\n` +
        `<i>Оставить оригинальный звук И добавить TTS поверх</i>\n\n` +
        `<b>Duck уровень:</b> ${duckDb} dB\n` +
        `<i>Насколько приглушить оригинал при политике Duck (от −40 до −3)</i>`
      );
    };

    const advancedKeyboard = (session: any): InlineKeyboard => {
      const keepWithTts = Boolean(session.advancedKeepWithTts);
      const duckDb = session.customDuckDb != null ? session.customDuckDb : -18;
      return new InlineKeyboard()
        .text(`KEEP+TTS: ${keepWithTts ? 'ВКЛ ✓' : 'ВЫКЛ'}`, 'adv:keep_tts')
        .row()
        .text(`Duck: ${duckDb} dB — изменить`, 'adv:duck_level')
        .row()
        .text('← Назад', 'adv:back');
    };

    bot.callbackQuery('s:advanced', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        advancedText(session),
        advancedKeyboard(session),
      );
    });

    bot.callbackQuery('adv:keep_tts', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      const enabled = !Boolean(session.advancedKeepWithTts);
      await this.sessions.setAdvancedKeepWithTts(session.id, enabled);
      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(ctx, msgId, advancedText(fresh), advancedKeyboard(fresh));
      await ctx.answerCallbackQuery({
        text: `KEEP+TTS: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`,
      });
    });

    bot.callbackQuery('adv:duck_level', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      const panelMsgId = ctx.callbackQuery?.message?.message_id as number;
      waiting.set(session.id, { type: 'duck_level', panelMsgId });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        '🦆 <b>Duck уровень</b>\n\nОтправь уровень в дБ от <code>-40</code> до <code>-3</code>\nПример: <code>-24</code>',
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '✕ Отмена',
            `cancel_input:${session.id}`,
          ),
        },
      );
    });

    bot.callbackQuery('adv:back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      const fresh = await this.sessions.getSessionById(session.id);
      await editPanel(
        ctx,
        msgId,
        standardPanelText(fresh),
        standardPanelKeyboard(fresh),
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Auto режим — выбор фона
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('auto:pick_video', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const videos = await this.bgLibrary.listVideos();
      if (!videos.length) {
        return ctx.answerCallbackQuery({
          text: '🎬 Библиотека пуста. Загрузи видео через /library.',
          show_alert: true,
        });
      }

      const bgFixed = session.fixedBackgroundVideoKey as string | null;
      const kb = new InlineKeyboard();
      kb.text(
        bgFixed ? '🎲 Случайное (сбросить)' : '🎲 Случайное ✓',
        'auto:set_video:random',
      ).row();
      for (const v of videos) {
        const name = v.filename.slice(0, 32);
        kb.text(
          bgFixed === v.key ? `✓ ${name}` : name,
          `auto:sv:${v.index}`,
        ).row();
      }
      kb.text('← Назад', 'auto:pick_back');

      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(ctx, msgId, '🎬 <b>Выбери фоновое видео</b>', kb);
    });

    bot.callbackQuery('auto:set_video:random', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      await this.sessions.setFixedBackgroundVideoKey(session.id, null);
      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        autoPanelText(fresh),
        autoPanelKeyboard(fresh),
      );
      await ctx.answerCallbackQuery({ text: '🎲 Видео: случайное' });
    });

    bot.callbackQuery(/^auto:sv:(\d+)$/, async (ctx) => {
      const idx = parseInt(ctx.match[1], 10);
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const videos = await this.bgLibrary.listVideos();
      const target = videos.find((v) => v.index === idx);
      if (!target)
        return ctx.answerCallbackQuery({ text: '❌ Видео не найдено' });

      await this.sessions.setFixedBackgroundVideoKey(session.id, target.key);
      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        autoPanelText(fresh),
        autoPanelKeyboard(fresh),
      );
      await ctx.answerCallbackQuery({
        text: `✅ ${target.filename.slice(0, 40)}`,
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Auto режим — выбор музыки
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('auto:pick_music', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const tracks = await this.musicLibrary.listTracks();
      if (!tracks.length) {
        return ctx.answerCallbackQuery({
          text: '🎵 Библиотека пуста. Загрузи треки через /library.',
          show_alert: true,
        });
      }

      const musicFixed = session.fixedBackgroundMusicKey as string | null;
      const kb = new InlineKeyboard();
      kb.text(
        musicFixed ? '🎲 Случайная (сбросить)' : '🎲 Случайная ✓',
        'auto:set_music:random',
      ).row();
      for (const t of tracks) {
        const name = t.filename.slice(0, 32);
        kb.text(
          musicFixed === t.key ? `✓ ${name}` : name,
          `auto:sm:${t.index}`,
        ).row();
      }
      kb.text('← Назад', 'auto:pick_back');

      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(ctx, msgId, '🎵 <b>Выбери фоновую музыку</b>', kb);
    });

    bot.callbackQuery('auto:set_music:random', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      await this.sessions.setFixedBackgroundMusicKey(session.id, null);
      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        autoPanelText(fresh),
        autoPanelKeyboard(fresh),
      );
      await ctx.answerCallbackQuery({ text: '🎲 Музыка: случайная' });
    });

    bot.callbackQuery(/^auto:sm:(\d+)$/, async (ctx) => {
      const idx = parseInt(ctx.match[1], 10);
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const tracks = await this.musicLibrary.listTracks();
      const target = tracks.find((t) => t.index === idx);
      if (!target)
        return ctx.answerCallbackQuery({ text: '❌ Трек не найден' });

      await this.sessions.setFixedBackgroundMusicKey(session.id, target.key);
      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        autoPanelText(fresh),
        autoPanelKeyboard(fresh),
      );
      await ctx.answerCallbackQuery({
        text: `✅ ${target.filename.slice(0, 40)}`,
      });
    });

    bot.callbackQuery('auto:pick_back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        autoPanelText(fresh),
        autoPanelKeyboard(fresh),
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Auto режим — пресет и YouTube
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('auto:preset_cycle', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      const cur = (session.textCardPreset as string) ?? 'default';
      const idx = PRESETS.indexOf(cur as any);
      const next = PRESETS[(idx + 1) % PRESETS.length];
      await this.sessions.setTextCardPreset(session.id, next);
      await cbRefresh(ctx, `Стиль: ${next}`);
    });

    bot.callbackQuery('auto:toggle_youtube', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      const enabled = !Boolean(session.autoPublishYoutube);
      await this.sessions.setAutoPublishYoutube(session.id, enabled);
      await cbRefresh(ctx, `Авто-YouTube: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Auto режим — статус анекдотов
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('auto:jokes_status', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { user, session } = await cbGetSession(ctx);
      if (!session) return;

      const meta = await this.jokesCache.getMeta();
      const stats = meta.cached
        ? await this.usedJokes.getStats(user.id, meta.count)
        : null;
      const refreshedStr = meta.refreshedAt
        ? new Date(meta.refreshedAt).toLocaleString('ru')
        : null;

      const pct = stats?.percent ?? 0;
      const filled = Math.round(pct / 10);
      const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);

      const text = [
        '📊 <b>Статус анекдотов</b>\n',
        meta.cached
          ? `✅ Пул: ${meta.count} анекдотов`
          : '⚠️ Пул пуст — нужен парсинг',
        refreshedStr ? `🕐 Загружен: ${refreshedStr}` : '',
        '',
        stats
          ? [
              `<b>Твоя история:</b>`,
              `Использовано: ${stats.used} из ${stats.total}`,
              `Осталось новых: ${stats.remaining}`,
              `${bar} ${pct}%`,
            ].join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        text,
        new InlineKeyboard()
          .text('🔄 Обновить пул анекдотов', 'auto:jokes_refresh')
          .row()
          .text('← Назад', 'auto:pick_back'),
      );
    });

    bot.callbackQuery('auto:jokes_refresh', async (ctx) => {
      await ctx.answerCallbackQuery({ text: '⏳ Обновляю...' });
      const { user, session } = await cbGetSession(ctx);
      if (!session) return;

      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await editPanel(
        ctx,
        msgId,
        '⏳ <b>Парсю анекдоты...</b>\n\n(10–30 секунд)',
        new InlineKeyboard(),
      );

      try {
        await this.jokesCache.invalidate();
        const jokes = await this.jokesCache.refreshCache();
        await this.usedJokes.reset(user.id);
        const stats = await this.usedJokes.getStats(user.id, jokes.length);

        const sample =
          jokes[Math.floor(Math.random() * Math.min(5, jokes.length))]?.slice(
            0,
            200,
          ) ?? '';
        const icon =
          jokes.length >= 50 ? '🟢' : jokes.length >= 20 ? '🟡' : '🔴';

        const text =
          `✅ <b>Кеш обновлён!</b>\n\n` +
          `${icon} Анекдотов в пуле: ${jokes.length}\n` +
          `Твоя история сброшена: ${stats.remaining} новых\n\n` +
          `<b>Пример:</b>\n<i>${sample}</i>`;

        const fresh = await this.sessions.getSessionById(session.id);
        await editPanel(
          ctx,
          msgId,
          text,
          new InlineKeyboard().text('← Назад к настройкам', 'auto:pick_back'),
        );
      } catch (e: any) {
        await editPanel(
          ctx,
          msgId,
          `❌ <b>Ошибка обновления</b>\n\n${String(e?.message).slice(0, 300)}`,
          new InlineKeyboard().text('← Назад', 'auto:pick_back'),
        );
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Запуск рендера
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery('do:approve', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { user, session } = await cbGetSession(ctx);
      if (!session) return ctx.reply('Нет сессии. /start');

      const isAuto = session.contentMode === ContentMode.SPANISH_JOKES_AUTO;

      if (!isAuto && !session.sourceVideoKey) {
        return ctx.answerCallbackQuery({
          text: '❌ Видео не загружено',
          show_alert: true,
        });
      }

      const msgId = ctx.callbackQuery?.message?.message_id as number;

      // Показываем "в очереди" немедленно
      await editPanel(
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

      waiting.delete(session.id);

      const job = await this.queues.enqueueRender({
        sessionId: session.id,
        userId: user.id,
        chatId: chatId(ctx),
      });

      const modeLabel = isAuto
        ? '🎭 Spanish Jokes Auto'
        : '🎬 Стандартный рендер';
      await editPanel(
        ctx,
        msgId,
        `⏳ <b>Рендер поставлен в очередь</b>\n\n` +
          `Режим: ${modeLabel}\n` +
          `Job ID: <code>${job.id}</code>\n\n` +
          `<i>Видео пришлю сюда, как только будет готово.</i>`,
        new InlineKeyboard().text('🔄 Статус', 'status:refresh'),
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Приём текстовых сообщений (ввод настроек)
    // ─────────────────────────────────────────────────────────────────────────
    bot.on('message:text', async (ctx) => {
      const text = (ctx.message.text || '').trim();
      if (text.startsWith('/')) return;

      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return;

      const w = waiting.get(session.id);
      if (!w) return;

      // Удаляем сообщение пользователя — держим чат чистым
      await tryDelete(ctx, ctx.message.message_id);

      let errorMsg: string | null = null;

      switch (w.type) {
        case 'tts_text': {
          if (!text) {
            errorMsg = 'Текст не может быть пустым. Попробуй ещё раз.';
            break;
          }
          await this.sessions.setTtsEnabled(session.id, true);
          await this.sessions.setTtsText(session.id, text.slice(0, 4000));
          break;
        }
        case 'language': {
          const val = text.toLowerCase() === 'auto' ? null : text.slice(0, 10);
          await this.sessions.setTtsSettings(session.id, { language: val });
          break;
        }
        case 'voice': {
          const val =
            text.toLowerCase() === 'default' ? null : text.slice(0, 50);
          await this.sessions.setTtsSettings(session.id, { voiceId: val });
          break;
        }
        case 'speed': {
          const num = parseFloat(text);
          if (isNaN(num) || num < 0.5 || num > 2.0) {
            errorMsg =
              '⚠️ Неверная скорость. Введи число от <code>0.5</code> до <code>2.0</code>';
            break;
          }
          await this.sessions.setTtsSettings(session.id, {
            ttsSpeed: Math.round(num * 100) / 100,
          });
          break;
        }
        case 'duck_level': {
          const num = parseFloat(text);
          if (isNaN(num) || num < -40 || num > -3) {
            errorMsg =
              '⚠️ Введи число от <code>-40</code> до <code>-3</code>, например <code>-18</code>';
            break;
          }
          await this.sessions.setCustomDuckDb(session.id, Math.round(num));
          break;
        }
        case 'comment': {
          if (!text) {
            errorMsg = 'Комментарий не может быть пустым.';
            break;
          }
          await this.sessions.setOverlayComment(session.id, text);
          break;
        }
      }

      if (errorMsg) {
        // Показываем ошибку — ждём нового ввода
        await ctx.reply(errorMsg, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '✕ Отмена',
            `cancel_input:${session.id}`,
          ),
        });
        return;
      }

      // Ввод принят — обновляем панель
      waiting.delete(session.id);
      const fresh = await this.sessions.getSessionById(session.id);
      await refreshPanel(ctx, fresh, w.panelMsgId);
    });
  }
}
