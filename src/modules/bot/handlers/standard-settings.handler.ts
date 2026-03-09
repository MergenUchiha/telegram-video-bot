import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import type { RenderSession } from '@prisma/client';
import { SessionsService } from '../../sessions/sessions.service';
import { BotContextHelper } from '../bot-context.helper';
import { WaitStateService } from '../../redis/wait-state/wait-state.service';
import { AUDIO_POLICIES, AudioPolicy } from '../bot.constants';
import { advancedPanelText, standardPanelText } from '../panels/index';
import { advancedKeyboard, standardPanelKeyboard } from '../keyboards/index';
import type { WaitType } from '../bot.types';

@Injectable()
export class StandardSettingsHandler {
  constructor(
    private readonly sessions: SessionsService,
    private readonly helper: BotContextHelper,
    private readonly waitState: WaitStateService,
  ) {}

  register(bot: Bot): void {
    this.registerTtsHandlers(bot);
    this.registerAudioHandlers(bot);
    this.registerAdvancedHandlers(bot);
    this.registerInputPrompts(bot);
    this.registerCancelHandler(bot);
  }

  private registerTtsHandlers(bot: Bot): void {
    bot.callbackQuery('s:tts_toggle', async (ctx) => {
      await ctx.answerCallbackQuery();
      const session = await this.getSession(ctx);
      if (!session) return;

      const enabled = !session.ttsEnabled;
      await this.sessions.setTtsEnabled(session.id, enabled);
      if (!enabled) await this.sessions.setSubtitlesMode(session.id, 'NONE');

      await this.refreshFreshSession(ctx, session.id);
      await ctx
        .answerCallbackQuery(`TTS: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`)
        .catch(() => {});
    });

    bot.callbackQuery('s:subs_toggle', async (ctx) => {
      const session = await this.getSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      if (!session.ttsEnabled) {
        return ctx.answerCallbackQuery({
          text: '⚠️ Субтитры доступны только при включённом TTS',
          show_alert: true,
        });
      }

      const cur = session.subtitlesMode ?? 'NONE';
      const next = cur === 'HARD' ? 'NONE' : 'HARD';
      await this.sessions.setSubtitlesMode(session.id, next);
      await this.refreshFreshSession(ctx, session.id);
      await ctx.answerCallbackQuery(`Субтитры: ${next}`).catch(() => {});
    });
  }

  private registerAudioHandlers(bot: Bot): void {
    for (const policy of AUDIO_POLICIES) {
      bot.callbackQuery(`s:audio:${policy}`, async (ctx) => {
        const session = await this.getSession(ctx);
        if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

        await this.sessions.setOriginalAudioPolicy(
          session.id,
          policy as AudioPolicy,
        );
        await this.refreshFreshSession(ctx, session.id);
        await ctx.answerCallbackQuery(`Звук: ${policy}`).catch(() => {});
      });
    }
  }

  private registerAdvancedHandlers(bot: Bot): void {
    bot.callbackQuery('s:advanced', async (ctx) => {
      await ctx.answerCallbackQuery();
      const session = await this.getSession(ctx);
      if (!session) return;

      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        advancedPanelText(session),
        advancedKeyboard(session),
      );
    });

    bot.callbackQuery('adv:keep_tts', async (ctx) => {
      const session = await this.getSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      const enabled = !session.advancedKeepWithTts;
      await this.sessions.setAdvancedKeepWithTts(session.id, enabled);

      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        advancedPanelText(fresh!),
        advancedKeyboard(fresh!),
      );
      await ctx.answerCallbackQuery({
        text: `KEEP+TTS: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`,
      });
    });

    bot.callbackQuery('adv:back', async (ctx) => {
      await ctx.answerCallbackQuery();
      const session = await this.getSession(ctx);
      if (!session) return;

      const fresh = await this.sessions.getSessionById(session.id);
      const msgId = ctx.callbackQuery.message?.message_id as number;
      await this.helper.editPanel(
        ctx,
        msgId,
        standardPanelText(fresh!),
        standardPanelKeyboard(fresh!),
      );
    });

    bot.callbackQuery('adv:duck_level', async (ctx) => {
      const session = await this.getSession(ctx);
      if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

      const panelMsgId = ctx.callbackQuery.message?.message_id as number;
      await ctx.answerCallbackQuery();

      const promptMsg = await ctx.reply(
        '🦆 <b>Duck уровень</b>\n\nОтправь уровень в дБ от <code>-40</code> до <code>-3</code>\nПример: <code>-24</code>',
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '✕ Отмена',
            `cancel_input:${session.id}`,
          ),
        },
      );

      await this.waitState.set(session.id, {
        type: 'duck_level',
        panelMsgId,
        promptMsgId: promptMsg.message_id,
      });
    });
  }

  private registerInputPrompts(bot: Bot): void {
    const prompts: Array<{
      query: string;
      type: WaitType;
      text: string;
      needsVideo?: boolean;
    }> = [
      {
        query: 's:tts_text',
        type: 'tts_text',
        text: '✍️ <b>Текст для TTS</b>\n\nОтправь текст, который озвучить:',
      },
      {
        query: 's:language',
        type: 'language',
        text: '🌐 <b>Язык TTS</b>\n\nОтправь код языка: <code>en</code>, <code>es</code>, <code>de</code>, <code>fr</code>, <code>ja</code>, <code>zh</code>\nИли <code>auto</code> для автоопределения',
      },
      {
        query: 's:voice',
        type: 'voice',
        text: '🎙 <b>Голос Kokoro</b>\n\nОтправь ID голоса:\n<code>af_heart</code>  <code>af_bella</code>  <code>am_michael</code>  <code>bf_emma</code>\nИли <code>default</code> для стандартного',
      },
      {
        query: 's:speed',
        type: 'speed',
        text: '⚡ <b>Скорость TTS</b>\n\nОтправь число от <code>0.5</code> до <code>2.0</code>\nПример: <code>1.2</code>',
      },
      {
        query: 's:comment',
        type: 'comment',
        text: '💬 <b>Комментарий на видео</b>\n\nОтправь текст — он появится внизу видео:',
        needsVideo: true,
      },
    ];

    for (const { query, type, text, needsVideo } of prompts) {
      bot.callbackQuery(query, async (ctx) => {
        const session = await this.getSession(ctx);
        if (!session) return ctx.answerCallbackQuery({ text: 'Нет сессии' });

        if (needsVideo && !session.sourceVideoKey) {
          return ctx.answerCallbackQuery({
            text: '❌ Сначала загрузи видео',
            show_alert: true,
          });
        }

        await ctx.answerCallbackQuery();
        const panelMsgId = ctx.callbackQuery.message?.message_id as number;

        const promptMsg = await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '✕ Отмена',
            `cancel_input:${session.id}`,
          ),
        });

        await this.waitState.set(session.id, {
          type,
          panelMsgId,
          promptMsgId: promptMsg.message_id,
        });
      });
    }
  }

  private registerCancelHandler(bot: Bot): void {
    bot.callbackQuery(/^cancel_input:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Отменено' });
      const sessionId = ctx.match[1];
      await this.waitState.delete(sessionId);
      try {
        await ctx.deleteMessage();
      } catch {}
    });
  }

  private async getSession(ctx: any): Promise<RenderSession | null> {
    const user = await this.sessions.getOrCreateUser(
      String(ctx.from?.id),
      String(ctx.chat?.id),
    );
    return this.sessions.getActiveSession(user.id);
  }

  private async refreshFreshSession(
    ctx: any,
    sessionId: string,
  ): Promise<void> {
    const fresh = await this.sessions.getSessionById(sessionId);
    if (!fresh) return;
    const msgId = ctx.callbackQuery?.message?.message_id as number;
    await this.helper.refreshSessionPanel(ctx, fresh, msgId);
  }
}
