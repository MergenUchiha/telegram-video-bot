import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import * as path from 'node:path';

export const LIBRARY_VIDEOS_PREFIX = 'library/backgrounds/';

export interface LibraryVideoInfo {
  key: string;
  filename: string;
  index: number;
}

@Injectable()
export class BackgroundLibraryService {
  private readonly logger = new Logger(BackgroundLibraryService.name);

  constructor(private readonly storage: StorageService) {}

  async listVideoKeys(): Promise<string[]> {
    const keys = await this.storage.listObjects(LIBRARY_VIDEOS_PREFIX);
    return keys.filter((k) => /\.(mp4|mov|avi|mkv|webm)$/i.test(k));
  }

  async listVideos(): Promise<LibraryVideoInfo[]> {
    const keys = await this.listVideoKeys();
    return keys.map((key, index) => ({
      key,
      filename: path.basename(key),
      index: index + 1,
    }));
  }

  async pickRandom(): Promise<string | null> {
    const keys = await this.listVideoKeys();
    if (!keys.length) {
      this.logger.warn(
        'Background library is empty! Use /library in bot to upload videos.',
      );
      return null;
    }
    return keys[Math.floor(Math.random() * keys.length)];
  }

  async uploadVideo(
    stream: NodeJS.ReadableStream,
    filename: string,
    fileSize?: number,
  ): Promise<string> {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
    const key = `${LIBRARY_VIDEOS_PREFIX}${Date.now()}_${safe}`;
    await this.storage.ensureBucketExists();
    await this.storage.uploadStream(key, stream as any, 'video/mp4', fileSize);
    this.logger.log(`Video uploaded to library: ${key}`);
    return key;
  }

  async deleteByIndex(index: number): Promise<string | null> {
    const videos = await this.listVideos();
    const target = videos.find((v) => v.index === index);
    if (!target) return null;
    await this.storage.deleteObject(target.key);
    this.logger.log(`Video deleted from library: ${target.key}`);
    return target.filename;
  }

  async count(): Promise<number> {
    return (await this.listVideoKeys()).length;
  }
}
