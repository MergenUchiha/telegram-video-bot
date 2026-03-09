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
import { JokesParserService } from '../jokes/jokes-parser.service';
import { JokesCacheService } from '../jokes/jokes-cache.service';
import { UsedJokesService } from '../jokes/used-jokes.service';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

type WaitType =
  | 'comment'
  | 'tts_text'
  | 'language'
  | 'voice'
  | 'speed'
  | 'duck_level';

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
    private readonly jokesParser: JokesParserService,
    private readonly jokesCache: JokesCacheService,
    private readonly usedJokes: UsedJokesService,
  ) {}

  register(bot: Bot) {
    const waiting = new Map<
      string,
      { type: WaitType; settingsMsgId: number }
    >();
    const promptMsgIds = new Map<string, number>();

    // ── Регистрация команд ───────────────────────────────────────────────
    void bot.api.setMyCommands([
      { command: 'new', description: '🎬 Новая сессия рендера' },
      {
        command: 'auto',
        description: '🎭 Spanish Jokes Auto — ролик автоматически',
      },
      { command: 'status', description: '📊 Статус рендера' },
      { command: 'settings', description: '⚙️ Настройки текущей сессии' },
      { command: 'start', description: '👋 Приветствие и помощь' },
    ]);

    // ── Rate limit middleware ─────────────────────────────────────────────
    bot.use(async (ctx, next) => {
      const userId = String(ctx.from?.id ?? 'unknown');
      const rl = await this.rateLimit.check(userId);
      if (!rl.allowed) {
        const msg = `⏳ Слишком много запросов. Попробуй через ${rl.resetInSec}с.`;
        try {
          if (ctx.callbackQuery) {
            await ctx.answerCallbackQuery({ text: msg, show_alert: true });
          } else {
            await ctx.reply(msg);
          }
        } catch {}
        return;
      }
      return next();
    });

    // ── Вспомогательные функции ──────────────────────────────────────────

    const getUser = (ctx: any) =>
      this.sessions.getOrCreateUser(String(ctx.from?.id), String(ctx.chat?.id));

    const clearWaiting = (sessionId: string) => {
      waiting.delete(sessionId);
      promptMsgIds.delete(sessionId);
    };

    const tryDelete = async (ctx: any, msgId: number | null | undefined) => {
      if (!msgId) return;
      try {
        await ctx.api.deleteMessage(String(ctx.chat?.id), msgId);
      } catch {}
    };

    // ── Текст блока настроек ──────────────────────────────────────────────

    const buildText = (
      session: any,
      title = '⚙️ Настройки рендера',
    ): string => {
      const isAuto = session.contentMode === ContentMode.SPANISH_JOKES_AUTO;

      if (isAuto) {
        return buildAutoText(session, title);
      }
      return buildStandardText(session, title);
    };

    const buildStandardText = (session: any, title: string): string => {
      const hasVideo = Boolean(session.sourceVideoKey);
      const tts = Boolean(session.ttsEnabled);
      const subs = String(session.subtitlesMode ?? 'NONE');
      const audio = String(session.originalAudioPolicy ?? 'DUCK');
      const duckDb = session.customDuckDb != null ? session.customDuckDb : -18;
      const overlayEnabled = Boolean(session.overlayEnabled);
      const comment = session.overlayComment as string | null;
      const keepWithTts = Boolean(session.advancedKeepWithTts);

      const lines: string[] = [title, ''];
      lines.push(`🎬 Видео: ${hasVideo ? 'загружено ✅' : 'не загружено ❌'}`);
      lines.push(`🎭 Режим: Стандартный`);
      lines.push('');
      lines.push(
        `🔊 Звук: ${audio}${audio === 'DUCK' ? `  (duck ${duckDb} dB)` : ''}`,
      );
      lines.push(`🗣 TTS: ${tts ? 'ВКЛ' : 'ВЫКЛ'}`);
      if (tts) {
        lines.push(`   🌐 Язык: ${session.language ?? 'auto'}`);
        lines.push(`   🎙 Голос: ${session.voiceId ?? 'default'}`);
        lines.push(
          `   ⚡ Скорость: ${session.ttsSpeed != null ? session.ttsSpeed + 'x' : '1.0x'}`,
        );
      }
      lines.push(`📝 Субтитры: ${subs}`);
      lines.push(
        `💬 Комментарий: ${
          overlayEnabled && comment
            ? `"${comment.slice(0, 80)}${comment.length > 80 ? '…' : ''}"`
            : '(нет)'
        }`,
      );
      if (keepWithTts) {
        lines.push('');
        lines.push('⚠️ Advanced: KEEP+TTS включён');
      }
      return lines.join('\n');
    };

    const buildAutoText = (session: any, title: string): string => {
      const autoPublish = Boolean((session as any).autoPublishYoutube);
      const preset = (session as any).textCardPreset ?? 'default';
      const bgKey = (session as any).backgroundVideoKey as string | null;
      const bgFixed = (session as any).fixedBackgroundVideoKey as string | null;
      const musicFixed = (session as any).fixedBackgroundMusicKey as
        | string
        | null;

      const videoLabel = bgFixed
        ? `📌 ${path.basename(bgFixed)}`
        : bgKey
          ? `📌 ${path.basename(bgKey)}`
          : '🎲 Случайное из библиотеки';
      const musicLabel = musicFixed
        ? `📌 ${path.basename(musicFixed)}`
        : '🎲 Случайная из библиотеки';

      const lines: string[] = [title, ''];
      lines.push(`🎭 Режим: Spanish Jokes Auto ✓`);
      lines.push('');
      lines.push(`🎬 Видео: ${videoLabel}`);
      lines.push(`🎵 Музыка: ${musicLabel}`);
      lines.push(`🃏 Стиль карточки: ${preset}`);
      lines.push(`📺 Авто-YouTube: ${autoPublish ? 'ВКЛ ✓' : 'ВЫКЛ'}`);
      return lines.join('\n');
    };

    // ── Клавиатуры ─────────────────────────────────────────────────────────

    const buildKeyboard = (session: any): InlineKeyboard => {
      const isAuto = session.contentMode === ContentMode.SPANISH_JOKES_AUTO;

      if (isAuto) {
        return buildAutoKeyboard(session);
      }
      return buildStandardKeyboard(session);
    };

    const buildStandardKeyboard = (session: any): InlineKeyboard => {
      const tts = Boolean(session.ttsEnabled);
      const subs = String(session.subtitlesMode ?? 'NONE');
      const audio = String(session.originalAudioPolicy ?? 'DUCK');
      const lang = String(session.language ?? 'auto');
      const voice = String(session.voiceId ?? 'default').slice(0, 12);
      const speed =
        session.ttsSpeed != null ? String(session.ttsSpeed) + 'x' : '1.0x';

      const audioBtn = (label: string, val: string) =>
        audio === val ? `${label} ✓` : label;

      const kb = new InlineKeyboard();

      // Переключатель режима
      kb.text('🎭 Переключить → Spanish Jokes Auto', 's:mode_toggle').row();

      kb.text(tts ? '🗣 TTS: ВКЛ ✓' : '🗣 TTS: ВЫКЛ', 's:tts_toggle').row();

      if (tts) {
        kb.text('✍️ Текст для TTS', 's:tts_text').row();
        kb.text(`🌐 ${lang}`, 's:language')
          .text(`🎙 ${voice}`, 's:voice')
          .text(`⚡ ${speed}`, 's:speed')
          .row();
        kb.text(
          subs === 'HARD' ? '📝 Субтитры: HARD ✓' : '📝 Субтитры: NONE',
          's:subs_toggle',
        ).row();
      }

      kb.text('💬 Добавить комментарий', 's:comment').row();

      kb.text(audioBtn('🔁 Replace', 'REPLACE'), 's:audio_replace')
        .text(audioBtn('🦆 Duck', 'DUCK'), 's:audio_duck')
        .row();
      kb.text(audioBtn('🔇 Mute', 'MUTE'), 's:audio_mute')
        .text(audioBtn('🔊 Keep', 'KEEP'), 's:audio_keep')
        .row();

      kb.text('⚙️ Advanced', 's:advanced').row();
      kb.text('✅ Рендерить!', 'do:approve').row();
      kb.text('🗑 Отменить сессию', 'do:cancel');
      return kb;
    };

    const buildAutoKeyboard = (session: any): InlineKeyboard => {
      const autoPublish = Boolean((session as any).autoPublishYoutube);
      const preset = (session as any).textCardPreset ?? 'default';
      const bgFixed = (session as any).fixedBackgroundVideoKey as string | null;
      const musicFixed = (session as any).fixedBackgroundMusicKey as
        | string
        | null;

      const videoBtn = bgFixed
        ? `🎬 Видео: ${path.basename(bgFixed).slice(0, 20)}… ✓`
        : '🎬 Видео: случайное 🎲';
      const musicBtn = musicFixed
        ? `🎵 Музыка: ${path.basename(musicFixed).slice(0, 20)}… ✓`
        : '🎵 Музыка: случайная 🎲';

      const kb = new InlineKeyboard();
      kb.text('🎬 Переключить → Стандартный', 's:mode_toggle').row();
      kb.text(videoBtn, 'auto:pick_video').row();
      kb.text(musicBtn, 'auto:pick_music').row();
      kb.text(`🃏 Стиль: ${preset}`, 'auto:preset_cycle').row();
      kb.text(
        autoPublish ? '📺 Авто-YouTube: ВКЛ ✓' : '📺 Авто-YouTube: ВЫКЛ',
        'auto:toggle_youtube',
      ).row();
      kb.text('🔍 Статус парсинга', 'auto:jokes_status').row();
      kb.text('✅ Запустить Auto!', 'do:approve').row();
      kb.text('🗑 Отменить сессию', 'do:cancel');
      return kb;
    };

    const buildAdvancedKeyboard = (session: any): InlineKeyboard => {
      const keepWithTts = Boolean(session.advancedKeepWithTts);
      const duckDb = session.customDuckDb != null ? session.customDuckDb : -18;
      return new InlineKeyboard()
        .text(`🔊 KEEP+TTS: ${keepWithTts ? 'ВКЛ ✓' : 'ВЫКЛ'}`, 'adv:keep_tts')
        .row()
        .text(`🦆 Duck уровень: ${duckDb} dB`, 'adv:duck_level')
        .row()
        .text('⬅️ Назад к настройкам', 'adv:back');
    };

    // ── Отправка/редактирование сообщения настроек ────────────────────────

    const sendOrEditSettings = async (
      ctx: any,
      session: any,
      targetMsgId?: number,
    ) => {
      const text = buildText(session);
      const kb = buildKeyboard(session);
      const chatId = String(ctx.chat?.id);
      const msgId = targetMsgId ?? session.lastBotMessageId ?? null;

      if (msgId) {
        try {
          await ctx.api.editMessageText(chatId, msgId, text, {
            reply_markup: kb,
          });
          if (session.lastBotMessageId !== msgId) {
            await this.sessions.setLastBotMessageId(session.id, msgId);
          }
          return msgId as number;
        } catch {}
      }

      const msg = await ctx.reply(text, { reply_markup: kb });
      await this.sessions.setLastBotMessageId(session.id, msg.message_id);
      return msg.message_id as number;
    };

    const sendPrompt = async (
      ctx: any,
      sessionId: string,
      text: string,
      type: WaitType,
      settingsMsgId: number,
    ) => {
      const msg = await ctx.reply(text);
      promptMsgIds.set(sessionId, msg.message_id);
      waiting.set(sessionId, { type, settingsMsgId });
    };

    const cbGetSession = async (ctx: any) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      return { user, session };
    };

    const applyAndRefresh = async (
      ctx: any,
      sessionId: string,
      toast?: string,
    ) => {
      const msgId = ctx.callbackQuery?.message?.message_id as
        | number
        | undefined;
      const fresh = await this.sessions.getSessionById(sessionId);
      await sendOrEditSettings(ctx, fresh, msgId);
      await ctx.answerCallbackQuery(toast ? { text: toast } : {});
    };

    // ════════════════════════════════════════════════════════════════════════
    // КОМАНДЫ
    // ════════════════════════════════════════════════════════════════════════

    bot.command('start', async (ctx) => {
      await ctx.reply(
        '👋 Привет! Я обрабатываю видео для блогера.\n\n' +
          '🎬 Стандартный режим:\n' +
          '  1. /new — создать сессию\n' +
          '  2. Отправь видео\n' +
          '  3. Настрой TTS / субтитры / звук\n' +
          '  4. ✅ Рендерить!\n\n' +
          '🎭 Spanish Jokes Auto:\n' +
          '  /auto — запустить автоматически\n' +
          '  (видео + анекдот + музыка — всё само)\n\n' +
          'Команды:\n' +
          '/settings — настройки\n' +
          '/status — прогресс\n' +
          '/new — новая сессия',
      );
    });

    bot.command('new', async (ctx) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);

      if (session) {
        const s = session.state;
        if (
          s === RenderSessionState.RENDER_QUEUED ||
          s === RenderSessionState.RENDERING
        ) {
          return ctx.reply(
            '⏳ Рендер выполняется. Дождись завершения, потом /new.',
          );
        }
        clearWaiting(session.id);
      }

      const newSession = await this.sessions.createNewSession(user.id);
      clearWaiting(newSession.id);
      await ctx.reply('🎬 Новая сессия создана.\nОтправь видео чтобы начать.');
    });

    /**
     * /auto — Spanish Jokes Auto mode
     * Создаёт сессию в режиме SPANISH_JOKES_AUTO, видео не нужно.
     * Сессия сразу READY_TO_RENDER.
     */
    bot.command('auto', async (ctx) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);

      if (session) {
        const s = session.state;
        if (
          s === RenderSessionState.RENDER_QUEUED ||
          s === RenderSessionState.RENDERING
        ) {
          return ctx.reply(
            '⏳ Рендер выполняется. Дождись завершения, потом /auto.',
          );
        }
        clearWaiting(session.id);
      }

      const newSession = await this.sessions.createSpanishJokesSession(user.id);
      clearWaiting(newSession.id);

      await ctx.reply(
        '🎭 Spanish Jokes Auto\n\n' +
          'Бот автоматически:\n' +
          '  📖 Возьмёт свежий испанский анекдот\n' +
          '  🎬 Выберет фоновое видео из библиотеки\n' +
          '  🎵 Подберёт фоновую музыку\n' +
          '  🃏 Наложит стильную карточку с текстом\n\n' +
          'Настрой параметры и жми ✅ Запустить Auto!',
      );

      await sendOrEditSettings(ctx, newSession);
    });

    bot.command('settings', async (ctx) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session)
        return ctx.reply('Нет активной сессии. Используй /new или /auto.');
      await this.sessions.setLastBotMessageId(session.id, null);
      await sendOrEditSettings(ctx, session);
    });

    bot.command('status', async (ctx) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('Нет активной сессии. Используй /new.');

      const cachedStatus = await this.progress.getStatus(session.id);
      const cachedProgress = await this.progress.getProgress(session.id);
      const lastError = await this.progress.getLastError(session.id);

      const lines: string[] = [];
      lines.push(`Состояние: ${cachedStatus?.state ?? session.state}`);
      if (typeof cachedProgress === 'number')
        lines.push(`Прогресс: ${cachedProgress}%`);
      if (cachedStatus?.message) lines.push(`Статус: ${cachedStatus.message}`);
      if (lastError) {
        const err =
          lastError.length > 400 ? '…' + lastError.slice(-400) : lastError;
        lines.push(`Ошибка: ${err}`);
      }
      await ctx.reply(lines.join('\n'));
    });

    // ════════════════════════════════════════════════════════════════════════
    // ВИДЕО
    // ════════════════════════════════════════════════════════════════════════

    bot.on('message:video', async (ctx) => {
      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return ctx.reply('Сначала создай сессию: /new');

      if (
        session.state === RenderSessionState.RENDER_QUEUED ||
        session.state === RenderSessionState.RENDERING
      ) {
        return ctx.reply(
          '⏳ Рендер выполняется. Отправь видео после завершения.',
        );
      }

      clearWaiting(session.id);

      const uploadMsg = await ctx.reply('⬇️ Загружаю видео...');
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

      // Если текущий режим Auto — видео используется как кастомный фон
      if ((session as any).contentMode === ContentMode.SPANISH_JOKES_AUTO) {
        await this.sessions.setState(
          session.id,
          RenderSessionState.READY_TO_RENDER,
        );
      } else {
        await this.sessions.setState(
          session.id,
          RenderSessionState.WAIT_TEXT_OR_SETTINGS,
        );
      }

      await this.sessions.setLastBotMessageId(session.id, null);
      await tryDelete(ctx, uploadMsg.message_id);

      const refreshed = await this.sessions.getSessionById(session.id);
      await sendOrEditSettings(ctx, refreshed);
    });

    // ════════════════════════════════════════════════════════════════════════
    // CALLBACKS — ПЕРЕКЛЮЧАТЕЛЬ РЕЖИМА
    // ════════════════════════════════════════════════════════════════════════

    bot.callbackQuery('s:mode_toggle', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session)
        return ctx.answerCallbackQuery({ text: 'Нет сессии. /new' });

      const isAuto =
        (session as any).contentMode === ContentMode.SPANISH_JOKES_AUTO;
      const newMode = isAuto
        ? ContentMode.STANDARD
        : ContentMode.SPANISH_JOKES_AUTO;
      await this.sessions.setContentMode(session.id, newMode);

      // При переключении в Auto — READY_TO_RENDER (видео не нужно)
      // При переключении в Standard — учитываем, есть ли видео
      if (newMode === ContentMode.SPANISH_JOKES_AUTO) {
        await this.sessions.setState(
          session.id,
          RenderSessionState.READY_TO_RENDER,
        );
      } else if (session.sourceVideoKey) {
        await this.sessions.setState(
          session.id,
          RenderSessionState.WAIT_TEXT_OR_SETTINGS,
        );
      } else {
        await this.sessions.setState(session.id, RenderSessionState.WAIT_VIDEO);
      }

      await applyAndRefresh(
        ctx,
        session.id,
        `Режим: ${newMode === ContentMode.SPANISH_JOKES_AUTO ? 'Spanish Jokes Auto 🎭' : 'Стандартный 🎬'}`,
      );
    });

    // ════════════════════════════════════════════════════════════════════════
    // CALLBACKS — SPANISH JOKES AUTO
    // ════════════════════════════════════════════════════════════════════════

    // Цикличное переключение пресета карточки
    const PRESETS = ['default', 'dark', 'light', 'minimal'];
    bot.callbackQuery('auto:preset_cycle', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      const current = (session as any).textCardPreset ?? 'default';
      const idx = PRESETS.indexOf(current);
      const next = PRESETS[(idx + 1) % PRESETS.length];
      await this.sessions.setTextCardPreset(session.id, next);
      await applyAndRefresh(ctx, session.id, `Стиль карточки: ${next}`);
    });

    bot.callbackQuery('auto:toggle_youtube', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      const enabled = !Boolean((session as any).autoPublishYoutube);
      await this.sessions.setAutoPublishYoutube(session.id, enabled);
      await applyAndRefresh(
        ctx,
        session.id,
        `Авто-YouTube: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`,
      );
    });

    // ── Выбор конкретного фонового видео ─────────────────────────────────

    bot.callbackQuery('auto:pick_video', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const videos = await this.bgLibrary.listVideos();
      if (!videos.length) {
        return ctx.reply(
          '🎬 Библиотека видео пуста.\n\nЗагрузи видео через /library → «Загрузить видео».',
        );
      }

      const kb = new InlineKeyboard();
      // Кнопка «Случайное»
      const bgFixed = (session as any).fixedBackgroundVideoKey;
      kb.text(
        bgFixed ? '🎲 Случайное (сбросить)' : '🎲 Случайное ✓',
        'auto:set_video:random',
      ).row();
      for (const v of videos) {
        const name = v.filename.slice(0, 35);
        const isCurrent = bgFixed === v.key;
        kb.text(
          isCurrent ? `✓ ${name}` : name,
          `auto:set_video:${v.index}`,
        ).row();
      }
      kb.text('⬅️ Назад', 'auto:pick_back');
      await ctx.reply('🎬 Выбери фоновое видео:', { reply_markup: kb });
    });

    bot.callbackQuery('auto:set_video:random', async (ctx) => {
      await ctx.answerCallbackQuery({
        text: '🎲 Будет выбрано случайное видео',
      });
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      await this.sessions.setFixedBackgroundVideoKey(session.id, null);
      try {
        await ctx.deleteMessage();
      } catch {}
      await applyAndRefresh(ctx, session.id, 'Видео: случайное');
    });

    bot.callbackQuery(/^auto:set_video:(\d+)$/, async (ctx) => {
      const idx = parseInt(ctx.match[1], 10);
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const videos = await this.bgLibrary.listVideos();
      const target = videos.find((v) => v.index === idx);
      if (!target) {
        return ctx.answerCallbackQuery({ text: '❌ Видео не найдено' });
      }

      await ctx.answerCallbackQuery({ text: `✅ ${target.filename}` });
      await this.sessions.setFixedBackgroundVideoKey(session.id, target.key);
      try {
        await ctx.deleteMessage();
      } catch {}
      await applyAndRefresh(ctx, session.id, `Видео: ${target.filename}`);
    });

    // ── Выбор конкретного музыкального трека ──────────────────────────────

    bot.callbackQuery('auto:pick_music', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const tracks = await this.musicLibrary.listTracks();
      if (!tracks.length) {
        return ctx.reply(
          '🎵 Музыкальная библиотека пуста.\n\nЗагрузи треки через /library → «Загрузить музыку».',
        );
      }

      const kb = new InlineKeyboard();
      const musicFixed = (session as any).fixedBackgroundMusicKey;
      kb.text(
        musicFixed ? '🎲 Случайная (сбросить)' : '🎲 Случайная ✓',
        'auto:set_music:random',
      ).row();
      for (const t of tracks) {
        const name = t.filename.slice(0, 35);
        const isCurrent = musicFixed === t.key;
        kb.text(
          isCurrent ? `✓ ${name}` : name,
          `auto:set_music:${t.index}`,
        ).row();
      }
      kb.text('⬅️ Назад', 'auto:pick_back');
      await ctx.reply('🎵 Выбери музыкальный трек:', { reply_markup: kb });
    });

    bot.callbackQuery('auto:set_music:random', async (ctx) => {
      await ctx.answerCallbackQuery({
        text: '🎲 Будет выбрана случайная музыка',
      });
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      await this.sessions.setFixedBackgroundMusicKey(session.id, null);
      try {
        await ctx.deleteMessage();
      } catch {}
      await applyAndRefresh(ctx, session.id, 'Музыка: случайная');
    });

    bot.callbackQuery(/^auto:set_music:(\d+)$/, async (ctx) => {
      const idx = parseInt(ctx.match[1], 10);
      const { session } = await cbGetSession(ctx);
      if (!session) return;

      const tracks = await this.musicLibrary.listTracks();
      const target = tracks.find((t) => t.index === idx);
      if (!target) {
        return ctx.answerCallbackQuery({ text: '❌ Трек не найден' });
      }

      await ctx.answerCallbackQuery({ text: `✅ ${target.filename}` });
      await this.sessions.setFixedBackgroundMusicKey(session.id, target.key);
      try {
        await ctx.deleteMessage();
      } catch {}
      await applyAndRefresh(ctx, session.id, `Музыка: ${target.filename}`);
    });

    bot.callbackQuery('auto:pick_back', async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        await ctx.deleteMessage();
      } catch {}
    });

    // ── Статус парсинга анекдотов ─────────────────────────────────────────

    bot.callbackQuery('auto:jokes_status', async (ctx) => {
      await ctx.answerCallbackQuery();
      // ВАЖНО: используем DB uuid (user.id), а не Telegram ID (ctx.from.id)
      // В Redis ключи jokes:used:{userId} хранятся по DB uuid
      const { user } = await cbGetSession(ctx);
      const userId = user.id;

      // Сначала показываем статус из кеша мгновенно
      const meta = await this.jokesCache.getMeta();
      const stats = meta.cached
        ? await this.usedJokes.getStats(userId, meta.count)
        : null;

      const refreshedStr = meta.refreshedAt
        ? new Date(meta.refreshedAt).toLocaleString('ru')
        : null;

      const quickLines = [
        '📊 Статус анекдотов',
        '',
        meta.cached
          ? `✅ Пул: ${meta.count} анекдотов`
          : '⚠️ Пул пуст — нужен парсинг',
        refreshedStr ? `🕐 Загружен: ${refreshedStr}` : '',
        `♻️ Обновится: когда все будут использованы`,
        '',
        stats
          ? [
              `📌 Твоя история:`,
              `   Использовано: ${stats.used} из ${stats.total}`,
              `   Осталось новых: ${stats.remaining}`,
              `   Прогресс: ${'▓'.repeat(Math.round(stats.percent / 10))}${'░'.repeat(10 - Math.round(stats.percent / 10))} ${stats.percent}%`,
            ].join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const kb = new InlineKeyboard()
        .text('🔄 Обновить кеш сейчас', 'auto:jokes_refresh')
        .text('⬅️ Назад', 'auto:pick_back');

      await ctx.reply(quickLines, { reply_markup: kb });
    });

    bot.callbackQuery('auto:jokes_refresh', async (ctx) => {
      await ctx.answerCallbackQuery({ text: '⏳ Обновляю...' });
      const { user } = await cbGetSession(ctx);
      const userId = user.id;
      const statusMsg = await ctx.reply(
        '⏳ Парсю анекдоты со всех источников...\n(10–30 секунд)',
      );

      try {
        await this.jokesCache.invalidate();
        const jokes = await this.jokesCache.refreshCache();
        const stats = await this.usedJokes.getStats(userId, jokes.length);
        const ttlMin = Math.round(
          Number((ctx as any).config?.get?.('JOKES_CACHE_TTL_SEC') ?? 21600) /
            60,
        );

        const poolIndicator =
          jokes.length >= 50 ? '🟢' : jokes.length >= 20 ? '🟡' : '🔴';

        const lines = [
          '✅ Кеш обновлён!',
          '',
          `${poolIndicator} Анекдотов в пуле: ${jokes.length}`,
          `📌 Твоя история: ${stats.used} использовано`,
          `🆕 Новых для тебя: ${stats.remaining}`,
          '',
          '🔍 Пример:',
          '─────────────',
          jokes[Math.floor(Math.random() * Math.min(5, jokes.length))]?.slice(
            0,
            200,
          ) ?? '',
        ];

        await ctx.api.editMessageText(
          String(ctx.chat?.id),
          statusMsg.message_id,
          lines.join('\n'),
        );
      } catch (e: any) {
        await ctx.api.editMessageText(
          String(ctx.chat?.id),
          statusMsg.message_id,
          `❌ Ошибка: ${e?.message}`,
        );
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // CALLBACKS — СТАНДАРТНЫЕ НАСТРОЙКИ
    // ════════════════════════════════════════════════════════════════════════

    bot.callbackQuery('s:tts_toggle', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session)
        return ctx.answerCallbackQuery({ text: 'Нет сессии. /new' });
      const enabled = !Boolean(session.ttsEnabled);
      await this.sessions.setTtsEnabled(session.id, enabled);
      if (!enabled) await this.sessions.setSubtitlesMode(session.id, 'NONE');
      await applyAndRefresh(
        ctx,
        session.id,
        `TTS: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`,
      );
    });

    bot.callbackQuery('s:tts_text', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await sendPrompt(
        ctx,
        session.id,
        '✍️ Отправь текст для TTS:',
        'tts_text',
        msgId,
      );
    });

    bot.callbackQuery('s:language', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await sendPrompt(
        ctx,
        session.id,
        '🌐 Отправь код языка (en, ru, de, fr, es, ja, zh...) или "auto":',
        'language',
        msgId,
      );
    });

    bot.callbackQuery('s:voice', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await sendPrompt(
        ctx,
        session.id,
        '🎙 Отправь ID голоса Kokoro или "default":\n(примеры: af_heart, af_bella, am_michael, bf_emma)',
        'voice',
        msgId,
      );
    });

    bot.callbackQuery('s:speed', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await sendPrompt(
        ctx,
        session.id,
        '⚡ Отправь скорость TTS (0.5 – 2.0, по умолчанию 1.0):',
        'speed',
        msgId,
      );
    });

    bot.callbackQuery('s:subs_toggle', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session)
        return ctx.answerCallbackQuery({ text: 'Нет сессии. /new' });
      if (!Boolean(session.ttsEnabled)) {
        return ctx.answerCallbackQuery({
          text: '⚠️ Субтитры доступны только при включённом TTS',
          show_alert: true,
        });
      }
      const cur = String(session.subtitlesMode ?? 'NONE');
      const next = cur === 'HARD' ? 'NONE' : 'HARD';
      await this.sessions.setSubtitlesMode(session.id, next as any);
      await applyAndRefresh(ctx, session.id, `Субтитры: ${next}`);
    });

    bot.callbackQuery('s:comment', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      if (!session.sourceVideoKey) {
        return ctx.answerCallbackQuery({
          text: '❌ Сначала загрузи видео',
          show_alert: true,
        });
      }
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await sendPrompt(
        ctx,
        session.id,
        '💬 Отправь текст комментария.\nОн будет прожжён в нижней части видео:',
        'comment',
        msgId,
      );
    });

    const audioPolicies: Array<[string, string, string]> = [
      ['s:audio_replace', 'REPLACE', 'Звук: Replace'],
      ['s:audio_duck', 'DUCK', 'Звук: Duck'],
      ['s:audio_mute', 'MUTE', 'Звук: Mute'],
      ['s:audio_keep', 'KEEP', 'Звук: Keep'],
    ];
    for (const [cbId, policy, toast] of audioPolicies) {
      bot.callbackQuery(cbId, async (ctx) => {
        const { session } = await cbGetSession(ctx);
        if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
        await this.sessions.setOriginalAudioPolicy(session.id, policy as any);
        await applyAndRefresh(ctx, session.id, toast);
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // CALLBACKS — ADVANCED
    // ════════════════════════════════════════════════════════════════════════

    bot.callbackQuery('s:advanced', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const keepWithTts = Boolean(session.advancedKeepWithTts);
      const duckDb = session.customDuckDb != null ? session.customDuckDb : -18;
      const msgId = ctx.callbackQuery?.message?.message_id as number;

      await ctx.api.editMessageText(
        String(ctx.chat?.id),
        msgId,
        `⚙️ Advanced настройки\n\n` +
          `🔊 KEEP+TTS: ${keepWithTts ? 'ВКЛ' : 'ВЫКЛ'}\n` +
          `  Оставить оригинальный звук И добавить TTS поверх.\n\n` +
          `🦆 Duck уровень: ${duckDb} dB\n` +
          `  На сколько приглушить оригинал при политике DUCK (-40 до -3).`,
        { reply_markup: buildAdvancedKeyboard(session) },
      );
    });

    bot.callbackQuery('adv:keep_tts', async (ctx) => {
      const { session } = await cbGetSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });
      const enabled = !Boolean(session.advancedKeepWithTts);
      await this.sessions.setAdvancedKeepWithTts(session.id, enabled);
      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      const duckDb =
        (fresh as any)?.customDuckDb != null
          ? (fresh as any).customDuckDb
          : -18;

      await ctx.api.editMessageText(
        String(ctx.chat?.id),
        msgId,
        `⚙️ Advanced настройки\n\n` +
          `🔊 KEEP+TTS: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}\n` +
          `  Оставить оригинальный звук И добавить TTS поверх.\n\n` +
          `🦆 Duck уровень: ${duckDb} dB\n` +
          `  На сколько приглушить оригинал при политике DUCK.`,
        { reply_markup: buildAdvancedKeyboard(fresh) },
      );
      await ctx.answerCallbackQuery({
        text: `KEEP+TTS: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`,
      });
    });

    bot.callbackQuery('adv:duck_level', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await sendPrompt(
        ctx,
        session.id,
        '🦆 Отправь уровень duck в dB (от -40 до -3, по умолчанию -18).\nПример: -24',
        'duck_level',
        msgId,
      );
    });

    bot.callbackQuery('adv:back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { session } = await cbGetSession(ctx);
      if (!session) return;
      const msgId = ctx.callbackQuery?.message?.message_id as number;
      await sendOrEditSettings(ctx, session, msgId);
    });

    // ════════════════════════════════════════════════════════════════════════
    // CALLBACKS — ДЕЙСТВИЯ
    // ════════════════════════════════════════════════════════════════════════

    bot.callbackQuery('do:approve', async (ctx) => {
      await ctx.answerCallbackQuery();
      const { user, session } = await cbGetSession(ctx);
      if (!session) return ctx.reply('Нет сессии. /new');

      const isAuto =
        (session as any).contentMode === ContentMode.SPANISH_JOKES_AUTO;

      // Для стандартного режима — видео обязательно
      if (!isAuto && !session.sourceVideoKey) {
        return ctx.reply('❌ Видео не загружено. Сначала отправь видео.');
      }

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

      const job = await this.queues.enqueueRender({
        sessionId: session.id,
        userId: user.id,
        chatId: String(ctx.chat?.id),
      });

      clearWaiting(session.id);

      const msgId = ctx.callbackQuery?.message?.message_id as number;
      const modeLabel = isAuto ? '🎭 Spanish Jokes Auto' : '🎬 Стандартный';
      const summaryText =
        `⏳ Рендер поставлен в очередь\n\n` +
        `Режим: ${modeLabel}\n` +
        buildText(session, 'Параметры этого рендера:') +
        `\n\nJob ID: ${job.id}\n/status — следить за прогрессом\n/new — новая сессия после завершения`;

      try {
        await ctx.api.editMessageText(String(ctx.chat?.id), msgId, summaryText);
      } catch {
        await ctx.reply(summaryText);
      }
    });

    bot.callbackQuery('do:cancel', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Сессия отменена' });
      const { user, session } = await cbGetSession(ctx);
      if (session) clearWaiting(session.id);
      await this.sessions.createNewSession(user.id);

      const msgId = ctx.callbackQuery?.message?.message_id as number;
      try {
        await ctx.api.editMessageText(
          String(ctx.chat?.id),
          msgId,
          '🗑 Сессия отменена.\n\nОтправь видео (/new) или запусти авторежим (/auto).',
        );
      } catch {}
    });

    // ════════════════════════════════════════════════════════════════════════
    // ТЕКСТОВЫЕ СООБЩЕНИЯ
    // ════════════════════════════════════════════════════════════════════════

    bot.on('message:text', async (ctx) => {
      const text = (ctx.message.text || '').trim();
      if (text.startsWith('/')) return;

      const user = await getUser(ctx);
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return;

      const w = waiting.get(session.id);
      if (!w) return;

      await tryDelete(ctx, ctx.message.message_id);
      await tryDelete(ctx, promptMsgIds.get(session.id));
      promptMsgIds.delete(session.id);
      waiting.delete(session.id);

      let errorMsg: string | null = null;

      switch (w.type) {
        case 'tts_text': {
          if (!text) {
            errorMsg = 'Пустой текст, попробуй снова.';
            break;
          }
          await this.sessions.setTtsEnabled(session.id, true);
          await this.sessions.setTtsText(session.id, text.slice(0, 4000));
          break;
        }
        case 'language': {
          const val =
            text.toLowerCase() === 'auto' ? null : text.slice(0, 10).trim();
          await this.sessions.setTtsSettings(session.id, { language: val });
          break;
        }
        case 'voice': {
          const val =
            text.toLowerCase() === 'default' ? null : text.slice(0, 50).trim();
          await this.sessions.setTtsSettings(session.id, { voiceId: val });
          break;
        }
        case 'speed': {
          const num = parseFloat(text);
          if (Number.isNaN(num) || num < 0.5 || num > 2.0) {
            errorMsg =
              '⚠️ Неверная скорость. Введи число 0.5–2.0 (например: 1.2)';
            break;
          }
          await this.sessions.setTtsSettings(session.id, {
            ttsSpeed: Math.round(num * 100) / 100,
          });
          break;
        }
        case 'duck_level': {
          const num = parseFloat(text);
          if (Number.isNaN(num) || num < -40 || num > -3) {
            errorMsg =
              '⚠️ Неверный уровень. Введи от -40 до -3 (например: -18)';
            break;
          }
          await this.sessions.setCustomDuckDb(session.id, Math.round(num));
          break;
        }
        case 'comment': {
          if (!text) {
            errorMsg = 'Пустой комментарий, попробуй снова.';
            break;
          }
          await this.sessions.setOverlayComment(session.id, text);
          break;
        }
      }

      if (errorMsg) {
        const msg = await ctx.reply(errorMsg);
        promptMsgIds.set(session.id, msg.message_id);
        waiting.set(session.id, w);
        return;
      }

      const fresh = await this.sessions.getSessionById(session.id);
      await sendOrEditSettings(ctx, fresh, w.settingsMsgId);
    });
  }
}
