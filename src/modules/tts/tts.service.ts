import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TtsRequest = {
  text: string;
  language?: string | null; // не используется в OpenAI-compatible endpoint, оставляем для совместимости
  voiceId?: string | null;
  speed?: number | null;
};

function truncate(s: string, n = 300) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

@Injectable()
export class TtsService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private baseUrl() {
    const base =
      this.config.get<string>('KOKORO_BASE_URL') || 'http://kokoro:8880';
    return base.replace(/\/$/, '');
  }

  private timeoutMs() {
    return Number(this.config.get<string>('KOKORO_TIMEOUT_MS') || '120000');
  }

  private apiPath() {
    // главный правильный endpoint для твоего Kokoro
    return (
      this.config.get<string>('KOKORO_API_PATH') || '/v1/audio/speech'
    ).trim();
  }

  private model() {
    return this.config.get<string>('KOKORO_MODEL') || 'kokoro';
  }

  private defaultVoice() {
    return this.config.get<string>('KOKORO_VOICE') || 'af_heart';
  }

  private responseFormat(): 'mp3' | 'wav' | 'flac' | 'opus' | 'pcm' {
    // В твоём openapi response_format поддерживает mp3/opus/flac/wav/pcm
    const v = (this.config.get<string>('KOKORO_RESPONSE_FORMAT') || 'wav')
      .trim()
      .toLowerCase();

    if (
      v === 'mp3' ||
      v === 'wav' ||
      v === 'flac' ||
      v === 'opus' ||
      v === 'pcm'
    )
      return v;

    return 'wav';
  }

  /**
   * Kokoro-fastapi endpoints бывают разными в образах.
   * В твоём случае — OpenAI-compatible: POST /v1/audio/speech
   * Мы используем KOKORO_API_PATH как главный, но оставляем fallback на старые пути.
   */
  async synthesizeToWav(outPath: string, req: TtsRequest): Promise<void> {
    const text = (req.text || '').trim();
    if (!text) throw new Error('TTS text is empty');

    const base = this.baseUrl();
    const timeout = this.timeoutMs();

    const primary = this.apiPath();
    const fallbacks = [
      '/v1/audio/speech',
      '/tts',
      '/api/tts',
      '/v1/tts',
      '/synthesize',
    ];

    // Уберём дубли и поставим primary первым
    const endpoints = Array.from(
      new Set(
        [primary, ...fallbacks].map((p) => (p.startsWith('/') ? p : `/${p}`)),
      ),
    );

    const voice = (req.voiceId || this.defaultVoice()).trim();
    const speed =
      typeof req.speed === 'number' && !Number.isNaN(req.speed)
        ? req.speed
        : 1.0;

    // OpenAI-compatible payload (как в openapi.json)
    const payload: any = {
      model: this.model(),
      input: text,
      voice,
      response_format: this.responseFormat(),
      speed,
      stream: false,
      return_download_link: false,
    };

    let lastErr: any;

    for (const ep of endpoints) {
      try {
        const url = `${base}${ep}`;
        const res = await firstValueFrom(
          this.http.post(url, payload, {
            responseType: 'arraybuffer',
            timeout,
            headers: {
              'content-type': 'application/json',
              // Многие сборки Kokoro отдают "сырой" аудиобуфер при этом заголовке
              'x-raw-response': 'true',
              accept: '*/*',
            },
            // чтобы мы могли сформировать понятную ошибку со статусом и телом
            validateStatus: () => true,
          }),
        );

        if (res.status < 200 || res.status >= 300) {
          const ct = String(res.headers?.['content-type'] || '');
          const bodyPreview = ct.includes('application/json')
            ? truncate(JSON.stringify(res.data))
            : truncate(
                Buffer.isBuffer(res.data)
                  ? res.data.toString('utf8')
                  : String(res.data),
              );

          throw new Error(
            `Kokoro responded with status ${res.status} for ${ep}. Body: ${bodyPreview}`,
          );
        }

        const buf = Buffer.from(res.data);
        if (!buf.length) throw new Error(`Empty TTS response body from ${ep}`);

        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
        await fs.promises.writeFile(outPath, buf);
        return;
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(
      `Kokoro TTS request failed (tried ${endpoints.join(', ')}). ` +
        `Check KOKORO_BASE_URL and KOKORO_API_PATH. Last error: ${
          lastErr?.message || String(lastErr)
        }`,
    );
  }
}
