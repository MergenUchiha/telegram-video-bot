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
}
