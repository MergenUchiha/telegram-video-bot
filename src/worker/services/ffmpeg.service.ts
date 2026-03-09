import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  constructor(private readonly config: ConfigService) {}

  get ffmpegPath(): string {
    return this.config.get<string>('FFMPEG_PATH') ?? 'ffmpeg';
  }

  get timeoutMs(): number {
    return Number(this.config.get<string>('RENDER_TIMEOUT_MS') ?? '1200000');
  }

  get outputWidth(): number {
    return Number(this.config.get<string>('OUTPUT_WIDTH') ?? '1080');
  }

  get outputHeight(): number {
    return Number(this.config.get<string>('OUTPUT_HEIGHT') ?? '1920');
  }

  get defaultDuckDb(): number {
    return Number(this.config.get<string>('DEFAULT_DUCK_DB') ?? '-18');
  }

  get musicVolumeDb(): string {
    return this.config.get<string>('MUSIC_VOLUME_DB') ?? '-18';
  }

  /** @deprecated fontPath используется только как fallback; overlay теперь через ASS */
  get fontPath(): string {
    return (
      this.config.get<string>('FONT_PATH') ?? 'C:\\Windows\\Fonts\\arial.ttf'
    );
  }

  /** Запускает ffmpeg с указанными аргументами */
  async run(args: string[], timeoutMs = this.timeoutMs): Promise<void> {
    try {
      const res = await execa(this.ffmpegPath, args, {
        all: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      if (res.all) this.logger.debug(res.all);
    } catch (e: unknown) {
      const err = e as any;
      const all = err?.all ? String(err.all) : '';
      const merged = all?.trim()
        ? `${err?.message}\n\nffmpeg output:\n${this.clip(all, 2400)}`
        : String(err?.message);
      this.logger.error(this.clip(merged, 2400));
      throw new Error(this.clip(merged, 2400));
    }
  }

  /** Нормализует громкость аудиофайла через loudnorm */
  async normalizeLoudness(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    await this.run([
      '-y',
      '-i',
      inputPath,
      '-af',
      'loudnorm=I=-16:LRA=11:TP=-1.5',
      outputPath,
    ]);
  }

  /** Формирует filter для scale + crop под целевое разрешение */
  buildScaleCropFilter(): string {
    const { outputWidth: w, outputHeight: h } = this;
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  }

  /** Добавляет ASS-субтитры к video filter */
  appendAssFilter(baseFilter: string, assPath: string): string {
    const assEsc = this.escapeFilterPath(assPath);
    return `${baseFilter},ass='${assEsc}'`;
  }

  /**
   * Добавляет overlay-комментарий через ASS (заменяет старый drawtext).
   * Принимает путь к готовому .ass файлу (создаётся в TextCardService.makeOverlayAss).
   */
  appendOverlayAssFilter(baseFilter: string, assPath: string): string {
    // Используем тот же механизм что и для субтитров — ass filter
    return this.appendAssFilter(baseFilter, assPath);
  }

  /** Экранирует путь для использования в ffmpeg filtergraph */
  escapeFilterPath(p: string): string {
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  }

  clip(s: string, max = 1800): string {
    const str = String(s ?? '');
    return str.length <= max ? str : `…(truncated)\n${str.slice(-max)}`;
  }

  /** Записывает текст в файл, гарантирует существование директории */
  async writeTextFile(filePath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Перенос текста по словам.
   * maxLineLen=18 — оптимально для кириллицы при fontsize=64 на 1080px
   */
  wrapText(text: string, maxLineLen = 18): string {
    const words = text.trim().split(/\s+/);
    const lines: string[] = [];
    let line = '';

    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (candidate.length <= maxLineLen) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        if (w.length > maxLineLen) {
          let rest = w;
          while (rest.length > maxLineLen) {
            lines.push(rest.slice(0, maxLineLen));
            rest = rest.slice(maxLineLen);
          }
          line = rest;
        } else {
          line = w;
        }
      }
    }

    if (line) lines.push(line);
    return lines.join('\n');
  }
}
