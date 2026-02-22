import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RenderSessionState } from '@prisma/client';

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
      data: {
        userId,
        isActive: true,
        state: RenderSessionState.WAIT_VIDEO,
      },
    });
  }

  async setState(sessionId: string, state: RenderSessionState) {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { state },
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

  async setOriginalAudioPolicy(sessionId: string, policy: 'KEEP' | 'MUTE') {
    return this.prisma.renderSession.update({
      where: { id: sessionId },
      data: { originalAudioPolicy: policy },
    });
  }
}
