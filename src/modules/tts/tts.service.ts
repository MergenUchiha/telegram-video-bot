import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TtsRequest = {
  text: string;
  language?: string | null;
  voiceId?: string | null;
  speed?: number | null;
};

function truncate(s: string, n = 300) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Языки, которые поддерживает Kokoro (ghcr.io/remsky/kokoro-fastapi-cpu).
 *
 *   a = American English
 *   b = British English
 *   e = Spanish (es)
 *   f = French (fr-fr)
 *   h = Hindi
 *   i = Italian
 *   j = Japanese
 *   p = Portuguese (pt-br)
 *   z = Mandarin Chinese
 *
 * Русский (ru) НЕ поддерживается этой моделью.
 * Для русского нужна другая TTS (Silero, XTTS, Edge-TTS и т.п.).
 */
const KOKORO_LANG_MAP: Record<string, string> = {
  en: 'a',
  'en-us': 'a',
  'en-gb': 'b',
  es: 'e',
  fr: 'f',
  'fr-fr': 'f',
  hi: 'h',
  it: 'i',
  ja: 'j',
  pt: 'p',
  'pt-br': 'p',
  zh: 'z',
  'zh-cn': 'z',
  'zh-tw': 'z',
};

/** Языки, которые точно НЕ поддерживаются Kokoro (для информирования пользователя) */
export const KOKORO_UNSUPPORTED_LANGUAGES = new Set([
  'ru',
  'de',
  'ko',
  'ar',
  'tr',
  'pl',
  'uk',
  'nl',
  'sv',
  'fi',
]);

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

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

  /** ISO 639-1 / BCP-47 → Kokoro lang_code. Undefined если язык не поддерживается. */
  getLangCode(language: string | null | undefined): string | undefined {
    if (!language || language.toLowerCase() === 'auto') return undefined;
    return KOKORO_LANG_MAP[language.toLowerCase()];
  }

  /** Проверяет, поддерживается ли язык Kokoro — для предупреждения в боте */
  isLanguageSupported(language: string | null | undefined): boolean {
    if (!language || language.toLowerCase() === 'auto') return true;
    return !KOKORO_UNSUPPORTED_LANGUAGES.has(language.toLowerCase());
  }

  async synthesizeToWav(outPath: string, req: TtsRequest): Promise<void> {
    const text = (req.text || '').trim();
    if (!text) throw new Error('TTS text is empty');

    // Проверяем язык заранее и выдаём понятную ошибку вместо загадочного 500
    if (
      req.language &&
      KOKORO_UNSUPPORTED_LANGUAGES.has(req.language.toLowerCase())
    ) {
      throw new Error(
        `Язык "${req.language}" не поддерживается Kokoro TTS.\n` +
          `Поддерживаемые языки: en, es, fr, hi, it, ja, pt, zh.\n` +
          `Для русского языка потребуется другая TTS-система (Silero, Edge-TTS и т.п.).`,
      );
    }

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
    const endpoints = Array.from(
      new Set(
        [primary, ...fallbacks].map((p) => (p.startsWith('/') ? p : `/${p}`)),
      ),
    );

    const voice = (
      req.voiceId && req.voiceId.toLowerCase() !== 'default'
        ? req.voiceId
        : this.defaultVoice()
    ).trim();

    const speed =
      typeof req.speed === 'number' && !Number.isNaN(req.speed)
        ? req.speed
        : 1.0;

    const langCode = this.getLangCode(req.language);
    if (langCode) {
      this.logger.log(
        `TTS lang=${req.language} → lang_code=${langCode}, voice=${voice}`,
      );
    }

    const payload: any = {
      model: this.model(),
      input: text,
      voice,
      response_format: this.responseFormat(),
      speed,
      stream: false,
      return_download_link: false,
      // lang_code добавляем только если язык реально поддерживается моделью
      ...(langCode ? { lang_code: langCode } : {}),
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
              'x-raw-response': 'true',
              accept: '*/*',
            },
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
        `Check KOKORO_BASE_URL and KOKORO_API_PATH. Last error: ${lastErr?.message || String(lastErr)}`,
    );
  }
}
