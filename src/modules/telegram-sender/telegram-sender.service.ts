import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';

@Injectable()
export class TelegramSenderService {
  private readonly token: string;
  private readonly apiBase: string;

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
    this.token = token;

    this.apiBase = (
      this.config.get<string>('TELEGRAM_API_BASE_URL') ||
      'https://api.telegram.org'
    ).replace(/\/$/, '');
  }

  async sendMessage(chatId: string, text: string) {
    const url = `${this.apiBase}/bot${this.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new Error(`sendMessage failed: ${res.status} ${res.statusText}`);
  }

  async sendVideoByUrl(chatId: string, videoUrl: string, caption?: string) {
    const url = `${this.apiBase}/bot${this.token}/sendVideo`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, video: videoUrl, caption }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `sendVideo failed: ${res.status} ${res.statusText} ${body}`.slice(
          0,
          500,
        ),
      );
    }
  }

  async sendVideoFile(chatId: string, filePath: string, caption?: string) {
    const url = `${this.apiBase}/bot${this.token}/sendVideo`;

    const stat = await fs.promises.stat(filePath);
    if (stat.size > 50 * 1024 * 1024) {
      throw new Error(`Video file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)`);
    }

    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption);
    form.set('video', new Blob([await fs.promises.readFile(filePath)]), 'out.mp4');

    const res = await fetch(url, {
      method: 'POST',
      body: form as any,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `sendVideo(file) failed: ${res.status} ${res.statusText} ${body}`.slice(
          0,
          500,
        ),
      );
    }
  }
}
