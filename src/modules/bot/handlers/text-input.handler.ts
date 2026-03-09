import { Injectable } from '@nestjs/common';
import { Bot, InlineKeyboard } from 'grammy';
import { SessionsService } from '../../sessions/sessions.service';
import { BotContextHelper } from '../bot-context.helper';
import { WaitStateService } from '../wait-state.service';
import { KOKORO_UNSUPPORTED_LANGUAGES } from '../../tts/tts.service';

@Injectable()
export class TextInputHandler {
  constructor(
    private readonly sessions: SessionsService,
    private readonly helper: BotContextHelper,
    private readonly waitState: WaitStateService,
  ) {}

  register(bot: Bot): void {
    bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) return;

      const user = await this.sessions.getOrCreateUser(
        String(ctx.from?.id),
        String(ctx.chat?.id),
      );
      const session = await this.sessions.getActiveSession(user.id);
      if (!session) return;

      const w = this.waitState.get(session.id);
      if (!w) return;

      await this.helper.tryDeleteMessage(ctx, ctx.message.message_id);

      const errorMsg = await this.processInput(session.id, w.type, text);

      if (errorMsg) {
        await ctx.reply(errorMsg, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text(
            '✕ Отмена',
            `cancel_input:${session.id}`,
          ),
        });
        return;
      }

      if (w.promptMsgId) {
        await this.helper.tryDeleteMessage(ctx, w.promptMsgId);
      }
      this.waitState.delete(session.id);

      const fresh = await this.sessions.getSessionById(session.id);
      if (fresh) {
        await this.helper.refreshSessionPanel(ctx, fresh, w.panelMsgId);
      }
    });
  }

  private async processInput(
    sessionId: string,
    type: string,
    text: string,
  ): Promise<string | null> {
    switch (type) {
      case 'tts_text': {
        if (!text) return 'Текст не может быть пустым. Попробуй ещё раз.';
        await this.sessions.setTtsEnabled(sessionId, true);
        await this.sessions.setTtsText(sessionId, text.slice(0, 4000));
        return null;
      }

      case 'language': {
        const val = text.toLowerCase() === 'auto' ? null : text.slice(0, 10);
        if (val && KOKORO_UNSUPPORTED_LANGUAGES.has(val.toLowerCase())) {
          return (
            `⚠️ <b>Язык "${val}" не поддерживается Kokoro TTS.</b>\n\n` +
            `Поддерживаемые языки:\n` +
            `<code>en</code> · <code>es</code> · <code>fr</code> · <code>hi</code> · ` +
            `<code>it</code> · <code>ja</code> · <code>pt</code> · <code>zh</code>\n\n` +
            `Или <code>auto</code> для дефолтного (английский).\n\n` +
            `<i>Для русского потребуется другая TTS-система.</i>`
          );
        }
        await this.sessions.setTtsSettings(sessionId, { language: val });
        return null;
      }

      case 'voice': {
        const val = text.toLowerCase() === 'default' ? null : text.slice(0, 50);
        await this.sessions.setTtsSettings(sessionId, { voiceId: val });
        return null;
      }

      case 'speed': {
        const num = parseFloat(text);
        if (isNaN(num) || num < 0.5 || num > 2.0) {
          return '⚠️ Неверная скорость. Введи число от <code>0.5</code> до <code>2.0</code>';
        }
        await this.sessions.setTtsSettings(sessionId, {
          ttsSpeed: Math.round(num * 100) / 100,
        });
        return null;
      }

      case 'duck_level': {
        const num = parseFloat(text);
        if (isNaN(num) || num < -40 || num > -3) {
          return '⚠️ Введи число от <code>-40</code> до <code>-3</code>, например <code>-18</code>';
        }
        await this.sessions.setCustomDuckDb(sessionId, Math.round(num));
        return null;
      }

      case 'comment': {
        if (!text) return 'Комментарий не может быть пустым.';
        await this.sessions.setOverlayComment(sessionId, text);
        return null;
      }

      default:
        return null;
    }
  }
}
