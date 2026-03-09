import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import type { RenderSession } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { BotContextHelper } from '../bot-context.helper';
import { BackgroundLibraryService } from '../../library/background-library.service';
import { MusicLibraryService } from '../../library/music-library.service';
import { JokesCacheService } from '../../jokes/jokes-cache.service';
import { UsedJokesService } from '../../jokes/used-jokes.service';
import { PRESETS } from '../bot.constants';
import { autoPanelText } from '../panels/index';
import { autoPanelKeyboard } from '../keyboards/index';

@Injectable()
export class AutoJokesHandler {
  constructor(
    private readonly sessions: SessionsService,
    private readonly helper: BotContextHelper,
    private readonly bgLibrary: BackgroundLibraryService,
    private readonly musicLibrary: MusicLibraryService,
    private readonly jokesCache: JokesCacheService,
    private readonly usedJokes: UsedJokesService,
  ) {}

  register(bot: Bot): void {
    this.registerVideoPickHandlers(bot);
    this.registerMusicPickHandlers(bot);
    this.registerPresetAndYoutubeHandlers(bot);
    this.registerJokesStatusHandlers(bot);
  }

  private registerVideoPickHandlers(bot: Bot): void {
    bot.callbackQuery('auto:pick_video', async (ctx) => {
      await ctx.answerCallbackQuery();
      const session = await this.getSession(ctx);
      if (!session) return;

      const videos = await this.bgLibrary.listVideos();
      if (!videos.length) {
        return ctx.answerCallbackQuery({
          text: '🎬 Библиотека пуста. Загрузи видео через /library.',
          show_alert: true,
        });
      }

      const bgFixed = session.fixedBackgroundVideoKey;
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

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        '🎬 <b>Выбери фоновое видео</b>',
        kb,
      );
    });

    bot.callbackQuery('auto:set_video:random', async (ctx) => {
      const session = await this.getSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      await this.sessions.setFixedBackgroundVideoKey(session.id, null);
      await this.refreshAutoPanel(ctx, session.id);
      await ctx.answerCallbackQuery({ text: '🎲 Видео: случайное' });
    });

    bot.callbackQuery(/^auto:sv:(\d+)$/, async (ctx) => {
      const idx = parseInt(ctx.match[1], 10);
      const session = await this.getSession(ctx);
      if (!session) return;

      const videos = await this.bgLibrary.listVideos();
      const target = videos.find((v) => v.index === idx);
      if (!target)
        return ctx.answerCallbackQuery({ text: '❌ Видео не найдено' });

      await this.sessions.setFixedBackgroundVideoKey(session.id, target.key);
      await this.refreshAutoPanel(ctx, session.id);
      await ctx.answerCallbackQuery({
        text: `✅ ${target.filename.slice(0, 40)}`,
      });
    });
  }

  private registerMusicPickHandlers(bot: Bot): void {
    bot.callbackQuery('auto:pick_music', async (ctx) => {
      await ctx.answerCallbackQuery();
      const session = await this.getSession(ctx);
      if (!session) return;

      const tracks = await this.musicLibrary.listTracks();
      if (!tracks.length) {
        return ctx.answerCallbackQuery({
          text: '🎵 Библиотека пуста. Загрузи треки через /library.',
          show_alert: true,
        });
      }

      const musicFixed = session.fixedBackgroundMusicKey;
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

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        '🎵 <b>Выбери фоновую музыку</b>',
        kb,
      );
    });

    bot.callbackQuery('auto:set_music:random', async (ctx) => {
      const session = await this.getSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      await this.sessions.setFixedBackgroundMusicKey(session.id, null);
      await this.refreshAutoPanel(ctx, session.id);
      await ctx.answerCallbackQuery({ text: '🎲 Музыка: случайная' });
    });

    bot.callbackQuery(/^auto:sm:(\d+)$/, async (ctx) => {
      const idx = parseInt(ctx.match[1], 10);
      const session = await this.getSession(ctx);
      if (!session) return;

      const tracks = await this.musicLibrary.listTracks();
      const target = tracks.find((t) => t.index === idx);
      if (!target)
        return ctx.answerCallbackQuery({ text: '❌ Трек не найден' });

      await this.sessions.setFixedBackgroundMusicKey(session.id, target.key);
      await this.refreshAutoPanel(ctx, session.id);
      await ctx.answerCallbackQuery({
        text: `✅ ${target.filename.slice(0, 40)}`,
      });
    });

    bot.callbackQuery('auto:pick_back', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.refreshCurrentSession(ctx);
    });
  }

  private registerPresetAndYoutubeHandlers(bot: Bot): void {
    bot.callbackQuery('auto:preset_cycle', async (ctx) => {
      const session = await this.getSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      const cur = (session.textCardPreset ?? 'default') as string;
      const idx = PRESETS.indexOf(cur as any);
      const next = PRESETS[(idx + 1) % PRESETS.length];
      await this.sessions.setTextCardPreset(session.id, next);

      await this.refreshAutoPanel(ctx, session.id);
      await ctx.answerCallbackQuery(`Стиль: ${next}`).catch(() => {});
    });

    bot.callbackQuery('auto:toggle_youtube', async (ctx) => {
      const session = await this.getSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      const enabled = !session.autoPublishYoutube;
      await this.sessions.setAutoPublishYoutube(session.id, enabled);

      await this.refreshAutoPanel(ctx, session.id);
      await ctx
        .answerCallbackQuery(`Авто-YouTube: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`)
        .catch(() => {});
    });
  }

  private registerJokesStatusHandlers(bot: Bot): void {
    bot.callbackQuery('auto:jokes_status', async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
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

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
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
      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return;

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
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

        await this.helper.editPanel(
          ctx,
          msgId,
          text,
          new InlineKeyboard().text('← Назад к настройкам', 'auto:pick_back'),
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.helper.editPanel(
          ctx,
          msgId,
          `❌ <b>Ошибка обновления</b>\n\n${msg.slice(0, 300)}`,
          new InlineKeyboard().text('← Назад', 'auto:pick_back'),
        );
      }
    });
  }

  private async getSession(ctx: any): Promise<RenderSession | null> {
    const user = await this.sessions.getOrCreateUser(
      String(ctx.from?.id),
      String(ctx.chat?.id),
    );
    return this.sessions.getActiveSession(user.id);
  }

  private async refreshAutoPanel(ctx: any, sessionId: string): Promise<void> {
    const fresh = await this.sessions.getSessionById(sessionId);
    if (!fresh) return;
    const msgId = ctx.callbackQuery?.message?.message_id as number;
    await this.helper.editPanel(
      ctx,
      msgId,
      autoPanelText(fresh),
      autoPanelKeyboard(fresh),
    );
  }

  private async refreshCurrentSession(ctx: any): Promise<void> {
    const session = await this.getSession(ctx);
    if (!session) return;
    const fresh = await this.sessions.getSessionById(session.id);
    if (!fresh) return;
    const msgId = ctx.callbackQuery?.message?.message_id as number;
    await this.helper.editPanel(
      ctx,
      msgId,
      autoPanelText(fresh),
      autoPanelKeyboard(fresh),
    );
  }
}
