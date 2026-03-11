import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

@Injectable()
export class SubtitlesService {
  /**
   * MVP: грубые тайминги — равномерно распределяем фразы по длительности.
   * Потом заменим на нормальную разметку/ASR/forced alignment.
   */
  async makeSrt(outPath: string, text: string, durationSec: number) {
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

  /**
   * Минимальный ASS стиль + safe-area снизу.
   * (Можно прожигать .srt напрямую, но ASS стабильнее по стилю/зоне.)
   */
  async srtToAss(outPath: string, srtPath: string) {
    const srt = await fs.promises.readFile(srtPath, 'utf-8');
    const ass = this.convertSrtToAss(srt);
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, ass, 'utf-8');
  }

  private splitToPhrases(text: string): string[] {
    const raw = (text || '').trim();
    if (!raw) return [];
    // простое разбиение: по точкам/воскл/вопр + лимит длины
    const parts = raw
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    // если текст без пунктуации — режем по ~42 символа
    if (parts.length <= 1 && raw.length > 60) {
      const out: string[] = [];
      let i = 0;
      while (i < raw.length) {
        out.push(raw.slice(i, i + 42).trim());
        i += 42;
      }
      return out.filter(Boolean);
    }

    return parts;
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
    // Очень простой конвертер SRT -> ASS (минимум, но работает)
    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1080',
      'PlayResY: 1920',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      // белый текст, чёрная обводка, safe-area снизу (MarginV)
      'Style: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,4,0,2,80,80,260,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ].join('\n');

    const blocks = srt
      .split(/\n\s*\n/g)
      .map((b) => b.trim())
      .filter(Boolean);

    const events: string[] = [];

    for (const b of blocks) {
      const lines = b.split('\n').map((x) => x.trim());
      if (lines.length < 3) continue;

      const timeLine = lines[1];
      const m = timeLine.match(
        /^(\d\d:\d\d:\d\d,\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d,\d\d\d)/,
      );
      if (!m) continue;

      const start = this.srtTimeToAss(m[1]);
      const end = this.srtTimeToAss(m[2]);
      const text = lines.slice(2).join('\\N').replace(/{/g, '\\{').replace(/}/g, '\\}');

      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
    }

    return `${header}\n${events.join('\n')}\n`;
  }

  private srtTimeToAss(t: string): string {
    // "00:00:01,230" -> "0:00:01.23"
    const [hh, mm, rest] = t.split(':');
    const [ss, ms] = rest.split(',');
    const centis = String(Math.floor(Number(ms) / 10)).padStart(2, '0');
    return `${Number(hh)}:${mm}:${ss}.${centis}`;
  }
}