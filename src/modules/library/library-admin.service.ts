import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackgroundLibraryService } from './background-library.service';
import { MusicLibraryService } from './music-library.service';
import * as path from 'node:path';

@Injectable()
export class LibraryAdminService {
  private readonly logger = new Logger(LibraryAdminService.name);
  private readonly adminIds: Set<string>;

  constructor(
    private readonly config: ConfigService,
    private readonly bgLibrary: BackgroundLibraryService,
    private readonly musicLibrary: MusicLibraryService,
  ) {
    const raw = this.config.get<string>('ADMIN_TELEGRAM_USER_IDS', '');
    this.adminIds = new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (!this.adminIds.size) {
      this.logger.warn('ADMIN_TELEGRAM_USER_IDS not set — /library disabled');
    }
  }

  isAdmin(telegramUserId: string): boolean {
    return this.adminIds.has(String(telegramUserId));
  }

  async getStatus(): Promise<string> {
    const [videos, tracks] = await Promise.all([
      this.bgLibrary.listVideos(),
      this.musicLibrary.listTracks(),
    ]);

    const lines: string[] = ['📚 Библиотека медиафайлов', ''];

    lines.push(`🎬 Фоновые видео: ${videos.length}`);
    if (videos.length) {
      for (const v of videos) lines.push(`  ${v.index}. ${v.filename}`);
    } else {
      lines.push('  (пусто)');
    }

    lines.push('');
    lines.push(`🎵 Музыка: ${tracks.length}`);
    if (tracks.length) {
      for (const t of tracks) lines.push(`  ${t.index}. ${t.filename}`);
    } else {
      lines.push('  (пусто)');
    }

    lines.push('');
    lines.push('Используй кнопки ниже для управления.');
    return lines.join('\n');
  }

  async deleteVideo(index: number): Promise<string> {
    const name = await this.bgLibrary.deleteByIndex(index);
    return name ? `✅ Видео удалено: ${name}` : `❌ Видео #${index} не найдено`;
  }

  async deleteTrack(index: number): Promise<string> {
    const name = await this.musicLibrary.deleteByIndex(index);
    return name ? `✅ Трек удалён: ${name}` : `❌ Трек #${index} не найден`;
  }

  static helpText(): string {
    return [
      '📚 Управление библиотеками',
      '(только для администратора)',
      '',
      '/library — статус и меню',
      '/library del_video <N>  — удалить видео #N',
      '/library del_music <N>  — удалить трек #N',
      '',
      '🎬 Загрузить фоновое видео:',
      '  Нажми «Загрузить видео» → отправь файл',
      '',
      '🎵 Загрузить музыку:',
      '  Нажми «Загрузить музыку» → отправь аудиофайл',
      '  Форматы: mp3, ogg, wav, aac, m4a, flac',
      '',
      '💡 Отправляй файлы через 📎 → Файл',
      '   (не как аудио/видео — иначе Telegram сожмёт)',
    ].join('\n');
  }
}
