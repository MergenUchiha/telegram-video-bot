import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import * as fs from 'node:fs';
import { PrismaService } from '../prisma/prisma.service';
import {
  YoutubeMetadataInput,
  YoutubeMetadataService,
} from './youtube-metadata.service';

export type YoutubeVisibilityValue = 'PUBLIC' | 'PRIVATE' | 'UNLISTED';

@Injectable()
export class YoutubeService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metadata: YoutubeMetadataService,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('YOUTUBE_CLIENT_ID') &&
      this.config.get<string>('YOUTUBE_CLIENT_SECRET') &&
      this.config.get<string>('YOUTUBE_REFRESH_TOKEN') &&
      this.config.get<string>('YOUTUBE_CHANNEL_ID'),
    );
  }

  async ensureSystemChannel(ownerUserId: string) {
    const channelId = this.config.get<string>('YOUTUBE_CHANNEL_ID');
    if (!channelId) return null;

    const channelTitle =
      this.config.get<string>('YOUTUBE_CHANNEL_TITLE') || 'Autonomy Channel';

    return this.prisma.youtubeChannel.upsert({
      where: {
        userId_channelId: {
          userId: ownerUserId,
          channelId,
        },
      },
      update: {
        channelTitle,
        isDefault: true,
        encryptedRefreshToken: 'env-managed',
      },
      create: {
        userId: ownerUserId,
        channelId,
        channelTitle,
        isDefault: true,
        encryptedRefreshToken: 'env-managed',
      },
    });
  }

  buildVideoMetadata(input: YoutubeMetadataInput) {
    return this.metadata.build(input);
  }

  async uploadVideo(params: {
    filePath: string;
    metadata: YoutubeMetadataInput;
    visibility: YoutubeVisibilityValue;
  }): Promise<{ videoId: string }> {
    if (!this.isConfigured()) {
      throw new Error('YouTube OAuth env vars are not fully configured');
    }

    const oauth = new google.auth.OAuth2(
      this.config.get<string>('YOUTUBE_CLIENT_ID'),
      this.config.get<string>('YOUTUBE_CLIENT_SECRET'),
    );
    oauth.setCredentials({
      refresh_token: this.config.get<string>('YOUTUBE_REFRESH_TOKEN'),
    });

    const youtube = google.youtube({ version: 'v3', auth: oauth });
    const built = this.metadata.build(params.metadata);
    const visibility = this.toApiVisibility(params.visibility);
    const categoryId =
      this.config.get<string>('YOUTUBE_CATEGORY_ID', '23') || '23';

    const response = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: built.title,
          description: built.description,
          categoryId,
          defaultLanguage: 'es',
          defaultAudioLanguage: 'es',
        },
        status: {
          privacyStatus: visibility,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        body: fs.createReadStream(params.filePath),
      },
    });

    const videoId = response.data.id;
    if (!videoId) {
      throw new Error('YouTube upload completed without returning a video id');
    }

    return { videoId };
  }

  private toApiVisibility(visibility: YoutubeVisibilityValue) {
    switch (visibility) {
      case 'PRIVATE':
        return 'private';
      case 'UNLISTED':
        return 'unlisted';
      default:
        return 'public';
    }
  }
}
