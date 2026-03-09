import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_CHARS_PER_SUBTITLE = 60; // макс символов в одном блоке субтитра
const MIN_CHARS_PER_SUBTITLE = 15; // минимум — не делим слишком мелко

@Injectable()
export class SubtitlesService {
  async makeSrt(
    outPath: string,
    text: string,
    durationSec: number,
  ): Promise<void> {
    const phrases = this.splitToPhrases(text);
    if (phrases.length === 0) throw new Error('No phrases for subtitles');

    const dur = Math.max(1, durationSec);
    const step = dur / phrases.length;
    let t = 0;
    const blocks: string[] = [];

    for (let i = 0; i < phrases.length; i++) {
      const start = t;
      const end = i === phrases.length - 1 ? dur : t + step;
      blocks.push(
        String(i + 1),
        `${this.toSrtTime(start)} --> ${this.toSrtTime(end)}`,
        phrases[i],
        '',
      );
      t += step;
    }

    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, blocks.join('\n'), 'utf-8');
  }

  async srtToAss(outPath: string, srtPath: string): Promise<void> {
    const srt = await fs.promises.readFile(srtPath, 'utf-8');
    const ass = this.convertSrtToAss(srt);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, ass, 'utf-8');
  }

  /**
   * Разбивает текст на фразы для субтитров.
   *
   * Логика:
   * 1. Сначала пробуем разбить по пунктуации (.!?;)
   * 2. Если фразы слишком длинные — разбиваем по запятым/союзам
   * 3. Если всё ещё длинно — нарезаем по MAX_CHARS_PER_SUBTITLE
   * 4. Объединяем слишком короткие куски с соседями
   */
  private splitToPhrases(text: string): string[] {
    const raw = (text || '').trim();
    if (!raw) return [];

    // Шаг 1: разбивка по конечной пунктуации
    let parts = raw
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?;])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Шаг 2: длинные части разбиваем по запятым или союзам
    parts = parts.flatMap((p) => {
      if (p.length <= MAX_CHARS_PER_SUBTITLE) return [p];
      return this.splitByCommaOrConjunction(p);
    });

    // Шаг 3: всё ещё длинные — нарезаем по символам
    parts = parts.flatMap((p) => {
      if (p.length <= MAX_CHARS_PER_SUBTITLE) return [p];
      return this.splitByLength(p, MAX_CHARS_PER_SUBTITLE);
    });

    // Шаг 4: объединяем слишком короткие куски
    return this.mergeShortParts(parts, MIN_CHARS_PER_SUBTITLE);
  }

  private splitByCommaOrConjunction(text: string): string[] {
    // Разбиваем по запятой или перед союзами (pero, y, que, porque, ...)
    const result = text
      .split(/(?<=,)\s+|(?=\s+(?:pero|aunque|porque|cuando|mientras|que)\s)/i)
      .map((s) => s.trim())
      .filter(Boolean);

    return result.length > 1 ? result : [text];
  }

  private splitByLength(text: string, maxLen: number): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxLen) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current =
          word.length > maxLen
            ? (chunks.push(word.slice(0, maxLen)), word.slice(maxLen))
            : word;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  private mergeShortParts(parts: string[], minLen: number): string[] {
    if (parts.length <= 1) return parts;

    const result: string[] = [];
    let buffer = '';

    for (const part of parts) {
      if (!buffer) {
        buffer = part;
        continue;
      }
      const merged = `${buffer} ${part}`;
      if (buffer.length < minLen && merged.length <= MAX_CHARS_PER_SUBTITLE) {
        buffer = merged;
      } else {
        result.push(buffer);
        buffer = part;
      }
    }

    if (buffer) result.push(buffer);
    return result;
  }

  private toSrtTime(sec: number): string {
    const s = Math.max(0, sec);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const ms = Math.floor((s - Math.floor(s)) * 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)},${String(ms).padStart(3, '0')}`;
  }

  private convertSrtToAss(srt: string): string {
    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1080',
      'PlayResY: 1920',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,4,0,2,80,80,260,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ].join('\n');

    const events = srt
      .split(/\n\s*\n/g)
      .map((b) => b.trim())
      .filter(Boolean)
      .reduce<string[]>((acc, b) => {
        const lines = b.split('\n').map((x) => x.trim());
        if (lines.length < 3) return acc;
        const m = lines[1].match(
          /^(\d\d:\d\d:\d\d,\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d,\d\d\d)/,
        );
        if (!m) return acc;
        const start = this.srtTimeToAss(m[1]);
        const end = this.srtTimeToAss(m[2]);
        const text = lines
          .slice(2)
          .join('\\N')
          .replace(/{/g, '\\{')
          .replace(/}/g, '\\}');
        acc.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
        return acc;
      }, []);

    return `${header}\n${events.join('\n')}\n`;
  }

  private srtTimeToAss(t: string): string {
    const [hh, mm, rest] = t.split(':');
    const [ss, ms] = rest.split(',');
    const centis = String(Math.floor(Number(ms) / 10)).padStart(2, '0');
    return `${Number(hh)}:${mm}:${ss}.${centis}`;
  }
}
