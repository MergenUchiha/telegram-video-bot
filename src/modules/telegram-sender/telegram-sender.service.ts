import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramSenderService {
  private readonly token: string;
  private readonly apiBase: string;

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
    this.token = token;

    this.apiBase = (this.config.get<string>('TELEGRAM_API_BASE_URL') || 'https://api.telegram.org')
      .replace(/\/$/, '');
  }

  async sendMessage(chatId: string, text: string) {
    const url = `${this.apiBase}/bot${this.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status} ${res.statusText}`);
  }

  async sendVideoByUrl(chatId: string, videoUrl: string, caption?: string) {
    const url = `${this.apiBase}/bot${this.token}/sendVideo`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, video: videoUrl, caption }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`sendVideo failed: ${res.status} ${res.statusText} ${body}`.slice(0, 500));
    }
  }
}