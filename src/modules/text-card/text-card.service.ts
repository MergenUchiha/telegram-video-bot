import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TextCardPreset = 'default' | 'dark' | 'light' | 'minimal';

@Injectable()
export class TextCardService {
  async makeJokeCard(
    outPath: string,
    text: string,
    durationSec: number,
    preset: TextCardPreset = 'default',
  ): Promise<void> {
    const endTime = this.toAssTime(Math.max(1, durationSec));
    const wrappedText = this.wrapForAss(text.trim());
    const style = this.getStyle(preset);

    const ass = [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 1080',
      'PlayResY: 1920',
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      style,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      `Dialogue: 0,0:00:00.00,${endTime},JokeCard,,0,0,0,,${wrappedText}`,
    ].join('\n');

    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, ass, 'utf-8');
  }

  private wrapForAss(text: string): string {
    return text
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}')
      .replace(/\n/g, '{\\N}');
  }

  private getStyle(preset: TextCardPreset): string {
    const styles: Record<TextCardPreset, string> = {
      default:
        'Style: JokeCard,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&H99111111,-1,0,0,0,100,100,1,0,3,16,0,5,90,90,0,1',
      dark: 'Style: JokeCard,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&HFF000000,-1,0,0,0,100,100,1,0,3,16,0,5,90,90,0,1',
      light:
        'Style: JokeCard,Arial,58,&H00000000,&H000000FF,&H00FFFFFF,&HCFFFFFFF,-1,0,0,0,100,100,1,0,3,16,0,5,90,90,0,1',
      minimal:
        'Style: JokeCard,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,5,1,5,90,90,0,1',
    };
    return styles[preset] ?? styles['default'];
  }

  private toAssTime(sec: number): string {
    const s = Math.max(0, sec);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const centis = Math.floor((s - Math.floor(s)) * 100);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${hh}:${p(mm)}:${p(ss)}.${p(centis)}`;
  }
}
