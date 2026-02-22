import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';

@Injectable()
export class TelegramFilesService {
  private readonly token: string;
  private readonly apiBase: string;

  constructor(private readonly config: ConfigService) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');

    this.token = token;
    // Если используешь локальный Bot API — оно подставится отсюда
    this.apiBase = (this.config.get<string>('TELEGRAM_API_BASE_URL') || 'https://api.telegram.org').replace(/\/$/, '');
  }

  /**
   * Получаем file_path через getFile, затем качаем file content stream.
   */
  async downloadFileStream(fileId: string): Promise<{ stream: Readable; filePath: string }> {
    const getFileUrl = `${this.apiBase}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const metaRes = await fetch(getFileUrl);
    if (!metaRes.ok) throw new Error(`Telegram getFile failed: ${metaRes.status} ${metaRes.statusText}`);
    const metaJson = await metaRes.json();
    const filePath: string | undefined = metaJson?.result?.file_path;
    if (!filePath) throw new Error('Telegram getFile: missing result.file_path');

    const downloadUrl = `${this.apiBase}/file/bot${this.token}/${filePath}`;
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) throw new Error(`Telegram file download failed: ${fileRes.status} ${fileRes.statusText}`);

    // Node18+ fetch body -> ReadableStream, конвертим в Node Readable
    const nodeStream = Readable.fromWeb(fileRes.body as any);
    return { stream: nodeStream, filePath };
  }
}