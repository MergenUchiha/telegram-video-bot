import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ContentMode,
  OriginalAudioPolicy,
  RenderSession,
  RenderSessionState,
  SubtitlesMode,
} from '@prisma/client';

type SessionUpdateData = Partial<{
  state: RenderSessionState;
  isActive: boolean;
  contentMode: ContentMode;
  sourceVideoKey: string | null;
  outputVideoKey: string | null;
  ttsEnabled: boolean;
  ttsText: string | null;
  language: string | null;
  voiceId: string | null;
  ttsSpeed: number | null;
  subtitlesMode: SubtitlesMode;
  overlayEnabled: boolean;
  overlayComment: string | null;
  originalAudioPolicy: OriginalAudioPolicy;
  advancedKeepWithTts: boolean;
  customDuckDb: number | null;
  jokeText: string;
  jokeSourceUrl: string | null;
  jokeLanguage: string | null;
  backgroundVideoKey: string | null;
  backgroundMusicKey: string | null;
  textCardPreset: string;
  autoPublishYoutube: boolean;
  fixedBackgroundVideoKey: string | null;
  fixedBackgroundMusicKey: string | null;
  outputWidth: number;
  outputHeight: number;
  progress: number;
  lastError: string;
  lastBotMessageId: number | null;
  telegramMeta: object;
}>;

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Пользователи ──────────────────────────────────────────────────────────

  async getOrCreateUser(telegramUserId: string, telegramChatId: string) {
    return this.prisma.user.upsert({
      where: { telegramUserId },
      update: { telegramChatId },
      create: { telegramUserId, telegramChatId },
    });
  }

  // ── Сессии — создание (с транзакцией против race condition) ───────────────

  async createNewSession(userId: string): Promise<RenderSession> {
    return this.prisma.$transaction(async (tx) => {
      await tx.renderSession.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      });
      return tx.renderSession.create({
        data: { userId, isActive: true, state: RenderSessionState.WAIT_VIDEO },
      });
    });
  }

  async createSpanishJokesSession(userId: string): Promise<RenderSession> {
    return this.prisma.$transaction(async (tx) => {
      await tx.renderSession.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      });
      return tx.renderSession.create({
        data: {
          userId,
          isActive: true,
          state: RenderSessionState.READY_TO_RENDER,
          contentMode: ContentMode.SPANISH_JOKES_AUTO,
        },
      });
    });
  }

  // ── Сессии — чтение ───────────────────────────────────────────────────────

  async getActiveSession(userId: string): Promise<RenderSession | null> {
    return this.prisma.renderSession.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSessionById(sessionId: string): Promise<RenderSession | null> {
    return this.prisma.renderSession.findUnique({ where: { id: sessionId } });
  }

  // ── Сессии — обновление ───────────────────────────────────────────────────

  private async update(
    sessionId: string,
    data: SessionUpdateData,
  ): Promise<RenderSession> {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: data as any,
    });
  }

  // ── Конкретные сеттеры ────────────────────────────────────────────────────

  async setState(
    sessionId: string,
    state: RenderSessionState,
  ): Promise<RenderSession> {
    return this.update(sessionId, { state });
  }

  async setContentMode(
    sessionId: string,
    mode: ContentMode,
  ): Promise<RenderSession> {
    return this.update(sessionId, { contentMode: mode });
  }

  async setTelegramMeta(
    sessionId: string,
    meta: object,
  ): Promise<RenderSession> {
    return this.update(sessionId, { telegramMeta: meta });
  }

  async setSourceVideoKey(
    sessionId: string,
    key: string,
  ): Promise<RenderSession> {
    return this.update(sessionId, { sourceVideoKey: key });
  }

  async setOutputVideoKey(
    sessionId: string,
    key: string,
  ): Promise<RenderSession> {
    return this.update(sessionId, { outputVideoKey: key });
  }

  async setProgress(
    sessionId: string,
    progress: number,
  ): Promise<RenderSession> {
    return this.update(sessionId, { progress });
  }

  async setLastError(
    sessionId: string,
    lastError: string,
  ): Promise<RenderSession> {
    return this.update(sessionId, { lastError });
  }

  async setOverlayComment(
    sessionId: string,
    overlayComment: string | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, {
      overlayComment,
      overlayEnabled: overlayComment !== null && overlayComment !== '',
    });
  }

  async setOriginalAudioPolicy(
    sessionId: string,
    policy: OriginalAudioPolicy,
  ): Promise<RenderSession> {
    return this.update(sessionId, { originalAudioPolicy: policy });
  }

  async setTtsEnabled(
    sessionId: string,
    enabled: boolean,
  ): Promise<RenderSession> {
    return this.update(sessionId, { ttsEnabled: enabled });
  }

  async setTtsText(
    sessionId: string,
    ttsText: string | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { ttsText });
  }

  async setSubtitlesMode(
    sessionId: string,
    mode: SubtitlesMode | 'NONE' | 'HARD' | 'SOFT',
  ): Promise<RenderSession> {
    return this.update(sessionId, { subtitlesMode: mode as SubtitlesMode });
  }

  async setTtsSettings(
    sessionId: string,
    data: {
      language?: string | null;
      voiceId?: string | null;
      ttsSpeed?: number | null;
    },
  ): Promise<RenderSession> {
    return this.update(sessionId, data);
  }

  async setAdvancedKeepWithTts(
    sessionId: string,
    enabled: boolean,
  ): Promise<RenderSession> {
    return this.update(sessionId, { advancedKeepWithTts: enabled });
  }

  async setCustomDuckDb(
    sessionId: string,
    duckDb: number | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { customDuckDb: duckDb });
  }

  async setLastBotMessageId(
    sessionId: string,
    messageId: number | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { lastBotMessageId: messageId });
  }

  async setJokeText(
    sessionId: string,
    jokeText: string,
  ): Promise<RenderSession> {
    return this.update(sessionId, { jokeText });
  }

  async setJokeSourceUrl(
    sessionId: string,
    url: string | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { jokeSourceUrl: url });
  }

  async setBackgroundVideoKey(
    sessionId: string,
    key: string | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { backgroundVideoKey: key });
  }

  async setBackgroundMusicKey(
    sessionId: string,
    key: string | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { backgroundMusicKey: key });
  }

  async setTextCardPreset(
    sessionId: string,
    preset: string,
  ): Promise<RenderSession> {
    return this.update(sessionId, { textCardPreset: preset });
  }

  async setAutoPublishYoutube(
    sessionId: string,
    enabled: boolean,
  ): Promise<RenderSession> {
    return this.update(sessionId, { autoPublishYoutube: enabled });
  }

  async setFixedBackgroundVideoKey(
    sessionId: string,
    key: string | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { fixedBackgroundVideoKey: key });
  }

  async setFixedBackgroundMusicKey(
    sessionId: string,
    key: string | null,
  ): Promise<RenderSession> {
    return this.update(sessionId, { fixedBackgroundMusicKey: key });
  }
}
