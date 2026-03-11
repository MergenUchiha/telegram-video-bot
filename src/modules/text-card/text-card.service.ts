import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TextCardPreset = 'default' | 'dark' | 'light' | 'minimal';

/**
 * Генерирует ASS-файл с визуальной карточкой для текста анекдота.
 *
 * Карточка отображается поверх фонового видео — вертикальная полоса
 * с полупрозрачным фоном, центрированным крупным белым текстом.
 *
 * Пресеты:
 *   default — тёмный полупрозрачный фон, белый текст
 *   dark    — чёрный фон, белый текст
 *   light   — белый фон, чёрный текст
 *   minimal — без фона, белый текст с чёрной обводкой
 *
 * PlayRes: 1080x1920 (соответствует OUTPUT_WIDTH x OUTPUT_HEIGHT)
 */
@Injectable()
export class TextCardService {
  /**
   * Создать ASS-файл для карточки с анекдотом.
   *
   * @param outPath    — путь для записи .ass файла
   * @param text       — текст анекдота
   * @param durationSec — длительность видео (для End-времени субтитра)
   * @param preset     — визуальный пресет
   */
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

  /**
   * Обернуть текст для ASS:
   * - заменить \n на {\N} (hard line break)
   * - экранировать { и }
   */
  private wrapForAss(text: string): string {
    return text
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}')
      .replace(/\n/g, '{\\N}');
  }

  /**
   * Стиль ASS по пресету.
   *
   * ASS цвет: &HAABBGGRR (AA=alpha, BB=blue, GG=green, RR=red)
   * &H00FFFFFF = непрозрачный белый
   * &H99111111 = 60% прозрачный очень тёмный (для background box)
   * &HCC111111 = 80% прозрачный тёмный
   *
   * BorderStyle:
   *   1 = outline + shadow (обводка вокруг текста)
   *   3 = opaque box (цельный прямоугольник, BackColour = цвет фона)
   *
   * Alignment: 5 = center-center (по центру кадра)
   * MarginV определяет смещение от центра вниз (для Align=5 это дополнительный сдвиг)
   */
  private getStyle(preset: TextCardPreset): string {
    // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,
    //         BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing,
    //         Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

    const presets: Record<TextCardPreset, string> = {
      // Тёмный полупрозрачный фон (60% непрозрачный), белый текст, жирный
      // BorderStyle 3 = opaque box (BackColour как фон прямоугольника)
      default:
        'Style: JokeCard,DejaVu Sans,58,&H00FFFFFF,&H000000FF,&H00000000,&H99111111,-1,0,0,0,100,100,1,0,3,16,0,5,90,90,0,1',

      // Полностью непрозрачный чёрный фон
      dark: 'Style: JokeCard,DejaVu Sans,58,&H00FFFFFF,&H000000FF,&H00000000,&HFF000000,-1,0,0,0,100,100,1,0,3,16,0,5,90,90,0,1',

      // Белый фон, чёрный текст
      light:
        'Style: JokeCard,DejaVu Sans,58,&H00000000,&H000000FF,&H00FFFFFF,&HCFFFFFFF,-1,0,0,0,100,100,1,0,3,16,0,5,90,90,0,1',

      // Без фона, только текст с обводкой (BorderStyle 1)
      minimal:
        'Style: JokeCard,DejaVu Sans,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,1,0,1,5,1,5,90,90,0,1',
    };

    return presets[preset] ?? presets['default'];
  }

  /** Конвертировать секунды в формат ASS: H:MM:SS.cc */
  private toAssTime(sec: number): string {
    const s = Math.max(0, sec);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    const centis = Math.floor((s - Math.floor(s)) * 100);
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return `${hh}:${pad2(mm)}:${pad2(ss)}.${pad2(centis)}`;
  }
}
