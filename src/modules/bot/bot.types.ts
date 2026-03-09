import type { RenderSession } from '@prisma/client';
import type { Context } from 'grammy';

export type WaitType =
  | 'comment'
  | 'tts_text'
  | 'language'
  | 'voice'
  | 'speed'
  | 'duck_level';

export interface WaitState {
  type: WaitType;
  panelMsgId: number;
  promptMsgId?: number;
}

export type BotContext = Context;
export type { RenderSession };
