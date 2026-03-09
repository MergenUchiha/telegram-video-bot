import { Injectable } from '@nestjs/common';
import { InlineKeyboard } from 'grammy';
import type { RenderSession } from '@prisma/client';
import { ContentMode } from '@prisma/client';
import { SessionsService } from '../sessions/sessions.service';
import { standardPanelText, autoPanelText } from './panels/index';
import { standardPanelKeyboard, autoPanelKeyboard } from './keyboards/index';

@Injectable()
export class BotContextHelper {
  constructor(private readonly sessions: SessionsService) {}

  getChatId(ctx: any): string {
    return String(ctx.chat?.id ?? ctx.from?.id);
  }

  async tryDeleteMessage(
    ctx: any,
    msgId: number | null | undefined,
  ): Promise<void> {
    if (!msgId) return;
    try {
      await ctx.api.deleteMessage(this.getChatId(ctx), msgId);
    } catch {
      // Сообщение уже удалено или нет прав
    }
  }

  async editPanel(
    ctx: any,
    msgId: number,
    text: string,
    kb: InlineKeyboard,
  ): Promise<number> {
    try {
      await ctx.api.editMessageText(this.getChatId(ctx), msgId, text, {
        reply_markup: kb,
        parse_mode: 'HTML',
      });
      return msgId;
    } catch {
      const m = await ctx.api.sendMessage(this.getChatId(ctx), text, {
        reply_markup: kb,
        parse_mode: 'HTML',
      });
      return m.message_id;
    }
  }

  async sendPanel(
    ctx: any,
    sessionId: string | null,
    text: string,
    kb: InlineKeyboard,
  ): Promise<number> {
    const m = await ctx.api.sendMessage(this.getChatId(ctx), text, {
      reply_markup: kb,
      parse_mode: 'HTML',
    });
    if (sessionId) {
      await this.sessions.setLastBotMessageId(sessionId, m.message_id);
    }
    return m.message_id;
  }

  async refreshSessionPanel(
    ctx: any,
    session: RenderSession,
    panelMsgId?: number,
  ): Promise<void> {
    const msgId = panelMsgId ?? session.lastBotMessageId;
    if (!msgId) return;

    const isAuto = session.contentMode === ContentMode.SPANISH_JOKES_AUTO;
    const text = isAuto ? autoPanelText(session) : standardPanelText(session);
    const kb = isAuto
      ? autoPanelKeyboard(session)
      : standardPanelKeyboard(session);

    const newId = await this.editPanel(ctx, msgId, text, kb);
    if (newId !== msgId) {
      await this.sessions.setLastBotMessageId(session.id, newId);
    }
  }

  async getUser(ctx: any, sessionsService: SessionsService) {
    return sessionsService.getOrCreateUser(
      String(ctx.from?.id),
      String(ctx.chat?.id),
    );
  }
}
