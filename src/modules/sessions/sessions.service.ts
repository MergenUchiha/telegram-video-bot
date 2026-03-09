import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContentMode, RenderSessionState } from '@prisma/client';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateUser(telegramUserId: string, telegramChatId: string) {
    return this.prisma.user.upsert({
      where: { telegramUserId },
      update: { telegramChatId },
      create: { telegramUserId, telegramChatId },
    });
  }

  async getActiveSession(userId: string) {
    return this.prisma.renderSession.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createNewSession(userId: string) {
    await this.prisma.renderSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });
    return this.prisma.renderSession.create({
      data: { userId, isActive: true, state: RenderSessionState.WAIT_VIDEO },
    });
  }

  /**
   * Создать новую сессию в режиме Spanish Jokes Auto.
   * Сессия сразу переходит в READY_TO_RENDER — видео пользователя не нужно.
   */
  async createSpanishJokesSession(userId: string) {
    await this.prisma.renderSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    });
    return this.prisma.renderSession.create({
      data: {
        userId,
        isActive: true,
        state: RenderSessionState.READY_TO_RENDER,
        contentMode: ContentMode.SPANISH_JOKES_AUTO,
      },
    });
  }

  async createAutonomousSession(
    userId: string,
    autonomousRunId: string,
    contentMode: ContentMode = ContentMode.SPANISH_JOKES_AUTO,
  ) {
    return this.prisma.renderSession.create({
      data: {
        userId,
        isActive: false,
        state: RenderSessionState.READY_TO_RENDER,
        contentMode,
        autoPublishYoutube: true,
        triggerSource: 'AUTONOMOUS' as any,
        autonomousRunId,
      } as any,
    });
  }

  async setState(sessionId: string, state: RenderSessionState) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { state },
    });
  }

  async setContentMode(sessionId: string, mode: ContentMode) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { contentMode: mode },
    });
  }

  async setTelegramMeta(sessionId: string, meta: any) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { telegramMeta: meta },
    });
  }

  async setSourceVideoKey(sessionId: string, key: string) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { sourceVideoKey: key },
    });
  }

  async setOutputVideoKey(sessionId: string, key: string) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { outputVideoKey: key },
    });
  }

  async setProgress(sessionId: string, progress: number) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { progress },
    });
  }

  async setLastError(sessionId: string, lastError: string) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { lastError },
    });
  }

  async getSessionById(sessionId: string) {
    return this.prisma.renderSession.findUnique({ where: { id: sessionId } });
  }

  async setOverlayComment(sessionId: string, overlayComment: string | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: {
        overlayComment,
        overlayEnabled: overlayComment ? true : false,
      },
    });
  }

  async setOriginalAudioPolicy(
    sessionId: string,
    policy: 'REPLACE' | 'DUCK' | 'MUTE' | 'KEEP',
  ) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { originalAudioPolicy: policy },
    });
  }

  async setTtsEnabled(sessionId: string, enabled: boolean) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { ttsEnabled: enabled },
    });
  }

  async setTtsText(sessionId: string, ttsText: string | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { ttsText },
    });
  }

  async setSubtitlesMode(sessionId: string, mode: 'NONE' | 'HARD' | 'SOFT') {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { subtitlesMode: mode },
    });
  }

  async setTtsSettings(
    sessionId: string,
    data: {
      language?: string | null;
      voiceId?: string | null;
      ttsSpeed?: number | null;
    },
  ) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data,
    });
  }

  async setAdvancedKeepWithTts(sessionId: string, enabled: boolean) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { advancedKeepWithTts: enabled },
    });
  }

  async setCustomDuckDb(sessionId: string, duckDb: number | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { customDuckDb: duckDb } as any,
    });
  }

  async setLastBotMessageId(sessionId: string, messageId: number | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { lastBotMessageId: messageId },
    });
  }

  // ── Spanish Jokes Auto ────────────────────────────────────────────────────

  async setJokeText(sessionId: string, jokeText: string) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { jokeText } as any,
    });
  }

  async setJokeSourceUrl(sessionId: string, url: string | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { jokeSourceUrl: url } as any,
    });
  }

  async setBackgroundVideoKey(sessionId: string, key: string | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { backgroundVideoKey: key } as any,
    });
  }

  async setBackgroundMusicKey(sessionId: string, key: string | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { backgroundMusicKey: key } as any,
    });
  }

  async setTextCardPreset(sessionId: string, preset: string) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { textCardPreset: preset } as any,
    });
  }

  async setAutoPublishYoutube(sessionId: string, enabled: boolean) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { autoPublishYoutube: enabled } as any,
    });
  }

  /** Зафиксировать конкретное фоновое видео (null = случайное из библиотеки) */
  async setFixedBackgroundVideoKey(sessionId: string, key: string | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { fixedBackgroundVideoKey: key } as any,
    });
  }

  /** Зафиксировать конкретный музыкальный трек (null = случайный из библиотеки) */
  async setFixedBackgroundMusicKey(sessionId: string, key: string | null) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { fixedBackgroundMusicKey: key } as any,
    });
  }
}
