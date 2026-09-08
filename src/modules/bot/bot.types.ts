import type { RenderSession } from '@prisma/client';
import type { Context, Filter, FilterQuery } from 'grammy';

export type WaitType =
  | 'comment'
  | 'tts_text'
  | 'language'
  | 'voice'
  | 'speed'
  | 'duck_level'
  | 'youtube_code';

export interface WaitState {
  type: WaitType;
  panelMsgId: number;
  promptMsgId?: number;
}

export type BotContext = Context;

/**
 * A context narrowed by the update it matched, so a payload grammY's filter
 * guarantees stays guaranteed when the handler passes ctx to another method.
 * FilteredContext<'message:video'> has a non-optional message.video.
 */
export type FilteredContext<Q extends FilterQuery> = Filter<Context, Q>;
export type { RenderSession };
