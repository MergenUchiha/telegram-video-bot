import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import * as path from 'node:path';

export const LIBRARY_MUSIC_PREFIX = 'library/music/';

export interface LibraryMusicInfo {
  key: string;
  filename: string;
  index: number;
}

@Injectable()
export class MusicLibraryService {
  private readonly logger = new Logger(MusicLibraryService.name);

  constructor(private readonly storage: StorageService) {}

  async listMusicKeys(): Promise<string[]> {
    const keys = await this.storage.listObjects(LIBRARY_MUSIC_PREFIX);
    return keys.filter((k) => /\.(mp3|wav|ogg|aac|m4a|flac)$/i.test(k));
  }

  async listTracks(): Promise<LibraryMusicInfo[]> {
    const keys = await this.listMusicKeys();
    return keys.map((key, index) => ({
      key,
      filename: path.basename(key),
      index: index + 1,
    }));
  }

  async pickRandom(): Promise<string | null> {
    const keys = await this.listMusicKeys();
    if (!keys.length) {
      this.logger.warn(
        'Music library is empty! Use /library to upload tracks.',
      );
      return null;
    }
    return keys[Math.floor(Math.random() * keys.length)];
  }

  async uploadTrack(
    stream: NodeJS.ReadableStream,
    filename: string,
    fileSize?: number,
  ): Promise<string> {
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
    const key = `${LIBRARY_MUSIC_PREFIX}${Date.now()}_${safe}`;
    await this.storage.ensureBucketExists();
    await this.storage.uploadStream(key, stream as any, 'audio/mpeg', fileSize);
    this.logger.log(`Track uploaded to library: ${key}`);
    return key;
  }

  async deleteByIndex(index: number): Promise<string | null> {
    const tracks = await this.listTracks();
    const target = tracks.find((t) => t.index === index);
    if (!target) return null;
    await this.storage.deleteObject(target.key);
    this.logger.log(`Track deleted from library: ${target.key}`);
    return target.filename;
  }

  async count(): Promise<number> {
    return (await this.listMusicKeys()).length;
  }
}
