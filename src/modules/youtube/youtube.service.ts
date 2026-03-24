import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, youtube_v3 } from 'googleapis';
import * as fs from 'node:fs';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../encryption/encryption.service';
import type { YoutubeChannel } from '@prisma/client';
import type { YouTubeVideoMeta } from './youtube.types';

const MAX_CHANNELS_PER_USER = 5;

@Injectable()
export class YouTubeService {
  private readonly logger = new Logger(YouTubeService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {
    this.clientId = this.config.getOrThrow<string>('YOUTUBE_CLIENT_ID');
    this.clientSecret = this.config.getOrThrow<string>('YOUTUBE_CLIENT_SECRET');
    this.redirectUri = this.config.getOrThrow<string>('YOUTUBE_REDIRECT_URI');
  }

  // ── OAuth ───────────────────────────────────────────────────────────────────

  private createOAuth2Client() {
    return new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
  }

  getAuthUrl(state: string): string {
    const oauth2 = this.createOAuth2Client();
    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
      ],
      state,
    });

    this.logger.log(`YouTube auth URL: ${url}`);
    return url;
  }

  async exchangeCode(code: string) {
    const oauth2 = this.createOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        'No refresh token received. Try revoking app access at https://myaccount.google.com/permissions and re-authorizing.',
      );
    }
    return tokens;
  }

  // ── Channel CRUD ────────────────────────────────────────────────────────────

  async addChannel(userId: string, code: string): Promise<YoutubeChannel> {
    const existing = await this.prisma.youtubeChannel.count({
      where: { userId },
    });
    if (existing >= MAX_CHANNELS_PER_USER) {
      throw new Error(
        `Максимум ${MAX_CHANNELS_PER_USER} каналов. Удалите один, чтобы подключить новый.`,
      );
    }

    const tokens = await this.exchangeCode(code);

    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials(tokens);

    const yt = google.youtube({ version: 'v3', auth: oauth2 });
    const res = await yt.channels.list({ part: ['snippet'], mine: true });

    const channel = res.data.items?.[0];
    if (!channel?.id || !channel.snippet?.title) {
      throw new Error('Не удалось получить информацию о YouTube-канале.');
    }

    const encryptedRefreshToken = this.encryption.encrypt(
      tokens.refresh_token!,
    );

    const isFirst = existing === 0;

    return this.prisma.youtubeChannel.upsert({
      where: {
        userId_channelId: { userId, channelId: channel.id },
      },
      update: {
        channelTitle: channel.snippet.title,
        encryptedRefreshToken,
      },
      create: {
        userId,
        channelId: channel.id,
        channelTitle: channel.snippet.title,
        encryptedRefreshToken,
        isDefault: isFirst,
      },
    });
  }

  async removeChannel(channelRecordId: string): Promise<void> {
    const ch = await this.prisma.youtubeChannel.findUnique({
      where: { id: channelRecordId },
    });
    if (!ch) return;

    await this.prisma.youtubeChannel.delete({
      where: { id: channelRecordId },
    });

    // Если удалён каналdefault — назначить другой (если есть)
    if (ch.isDefault) {
      const next = await this.prisma.youtubeChannel.findFirst({
        where: { userId: ch.userId },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await this.prisma.youtubeChannel.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
  }

  async listChannels(userId: string): Promise<YoutubeChannel[]> {
    return this.prisma.youtubeChannel.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async setDefault(userId: string, channelRecordId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.youtubeChannel.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      this.prisma.youtubeChannel.update({
        where: { id: channelRecordId },
        data: { isDefault: true },
      }),
    ]);
  }

  async getDefault(userId: string): Promise<YoutubeChannel | null> {
    return this.prisma.youtubeChannel.findFirst({
      where: { userId, isDefault: true },
    });
  }

  async getChannelById(
    channelRecordId: string,
  ): Promise<YoutubeChannel | null> {
    return this.prisma.youtubeChannel.findUnique({
      where: { id: channelRecordId },
    });
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async uploadVideo(
    channelRecordId: string,
    filePath: string,
    meta: YouTubeVideoMeta,
  ): Promise<string> {
    const ch = await this.prisma.youtubeChannel.findUnique({
      where: { id: channelRecordId },
    });
    if (!ch)
      throw new Error(`YouTube channel record not found: ${channelRecordId}`);

    const refreshToken = this.encryption.decrypt(ch.encryptedRefreshToken);

    const oauth2 = this.createOAuth2Client();
    oauth2.setCredentials({ refresh_token: refreshToken });

    const yt = google.youtube({ version: 'v3', auth: oauth2 });

    this.logger.log(
      `Uploading to channel "${ch.channelTitle}" (${ch.channelId}): "${meta.title}"`,
    );

    const res = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: meta.title.slice(0, 100),
          description: meta.description.slice(0, 5000),
          tags: meta.tags.slice(0, 30),
        },
        status: {
          privacyStatus: meta.privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(filePath),
      },
    });

    const videoId = res.data.id;
    if (!videoId) throw new Error('YouTube API returned no video ID');

    this.logger.log(`Upload complete: https://youtu.be/${videoId}`);
    return videoId;
  }

  // ── YouTube Upload Records ──────────────────────────────────────────────────

  async createUploadRecord(sessionId: string, channelId: string) {
    return this.prisma.youtubeUpload.create({
      data: {
        sessionId,
        channelId,
        status: 'QUEUED',
      },
    });
  }

  async updateUploadRecord(
    uploadId: string,
    data: {
      status?: 'QUEUED' | 'UPLOADING' | 'DONE' | 'FAILED';
      youtubeVideoId?: string;
      error?: string;
      startedAt?: Date;
      finishedAt?: Date;
    },
  ) {
    return this.prisma.youtubeUpload.update({
      where: { id: uploadId },
      data,
    });
  }
}
