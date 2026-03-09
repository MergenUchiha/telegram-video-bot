import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import type { RenderSession } from '@prisma/client';
import { FfmpegService } from './ffmpeg.service';
import { StorageService } from '../../modules/storage/storage.service';
import { ProgressService } from '../../modules/redis/progress.service';
import { TtsService } from '../../modules/tts/tts.service';
import { MediaProbeService } from '../../modules/media-probe/media-probe.service';
import { SubtitlesService } from '../../modules/subtitles/subtitles.service';
import { TextCardService } from '../../modules/text-card/text-card.service';

export interface StandardRenderOptions {
  session: RenderSession;
  tmpDir: string;
}

@Injectable()
export class StandardRenderService {
  private readonly logger = new Logger(StandardRenderService.name);

  constructor(
    private readonly ffmpeg: FfmpegService,
    private readonly storage: StorageService,
    private readonly progress: ProgressService,
    private readonly tts: TtsService,
    private readonly probe: MediaProbeService,
    private readonly subs: SubtitlesService,
    private readonly textCard: TextCardService,
  ) {}

  async render({ session, tmpDir }: StandardRenderOptions): Promise<string> {
    const sessionId = session.id;
    if (!session.sourceVideoKey) throw new Error('sourceVideoKey missing');

    const paths = this.buildPaths(tmpDir);

    const duckDb = session.customDuckDb ?? this.ffmpeg.defaultDuckDb;

    await this.storage.downloadToFile(session.sourceVideoKey, paths.input);
    await this.progress.setProgress(sessionId, 15);

    const meta = await this.probe.probe(paths.input);
    await this.progress.setProgress(sessionId, 20);

    let vf = this.ffmpeg.buildScaleCropFilter();

    // Overlay comment — через ASS (корректная кириллица, без emoji-крашей)
    vf = await this.buildOverlayFilter(
      vf,
      session,
      paths.overlayAss,
      meta.durationSec || 10,
    );

    // TTS generation
    const ttsEnabled = Boolean(session.ttsEnabled);
    const ttsText = session.ttsText?.trim() ?? '';

    if (ttsEnabled) {
      if (!ttsText) throw new Error('TTS включён, но ttsText пуст');

      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'Генерирую TTS...',
      });

      await this.tts.synthesizeToWav(paths.ttsWav, {
        text: ttsText,
        language: session.language ?? null,
        voiceId: session.voiceId ?? null,
        speed: session.ttsSpeed ?? null,
      });

      await this.progress.setProgress(sessionId, 35);
      await this.ffmpeg.normalizeLoudness(paths.ttsWav, paths.ttsNormWav);
      await this.progress.setProgress(sessionId, 45);

      // Hard subtitles
      if (session.subtitlesMode === 'HARD') {
        await this.progress.setStatus(sessionId, {
          state: 'RENDERING',
          updatedAt: new Date().toISOString(),
          message: 'Генерирую субтитры...',
        });
        await this.subs.makeSrt(paths.srt, ttsText, meta.durationSec || 10);
        await this.subs.srtToAss(paths.ass, paths.srt);
        vf = this.ffmpeg.appendAssFilter(vf, paths.ass);
        await this.progress.setProgress(sessionId, 55);
      }
    }

    await this.progress.setProgress(sessionId, 70);
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'FFmpeg обрабатывает...',
    });

    const ffmpegArgs = this.buildFfmpegArgs({
      inputPath: paths.input,
      ttsNormPath: paths.ttsNormWav,
      outputPath: paths.output,
      vf,
      fps: meta.fps || 30,
      hasAudio: meta.hasAudio,
      ttsEnabled,
      policy: session.originalAudioPolicy,
      advancedKeepWithTts: Boolean(session.advancedKeepWithTts),
      duckDb,
    });

    await this.ffmpeg.run(ffmpegArgs);
    await this.progress.setProgress(sessionId, 80);

    return paths.output;
  }

  private buildPaths(tmpDir: string) {
    return {
      input: path.join(tmpDir, 'input.mp4'),
      output: path.join(tmpDir, 'out.mp4'),
      ttsWav: path.join(tmpDir, 'tts.wav'),
      ttsNormWav: path.join(tmpDir, 'tts_norm.wav'),
      srt: path.join(tmpDir, 'subs.srt'),
      ass: path.join(tmpDir, 'subs.ass'),
      overlayAss: path.join(tmpDir, 'overlay.ass'), // ← ASS вместо .txt
    };
  }

  /**
   * Строит overlay через ASS-субтитры (вместо drawtext).
   * Это решает:
   *   - кракозябры/квадраты с кириллицей (drawtext требует корректный fontfile)
   *   - emoji-краши (emoji стрипаются в makeOverlayAss)
   *   - обрезку текста (libass сам переносит по WrapStyle=1)
   */
  private async buildOverlayFilter(
    baseFilter: string,
    session: RenderSession,
    overlayAssFile: string,
    durationSec: number,
  ): Promise<string> {
    if (!session.overlayEnabled || !session.overlayComment) return baseFilter;

    await this.textCard.makeOverlayAss(
      overlayAssFile,
      session.overlayComment,
      durationSec,
    );

    return this.ffmpeg.appendOverlayAssFilter(baseFilter, overlayAssFile);
  }

  private buildFfmpegArgs(opts: {
    inputPath: string;
    ttsNormPath: string;
    outputPath: string;
    vf: string;
    fps: number;
    hasAudio: boolean;
    ttsEnabled: boolean;
    policy: string;
    advancedKeepWithTts: boolean;
    duckDb: number;
  }): string[] {
    const {
      inputPath,
      ttsNormPath,
      outputPath,
      vf,
      fps,
      hasAudio,
      ttsEnabled,
      policy,
      advancedKeepWithTts,
      duckDb,
    } = opts;

    const inputs: string[] = ['-y', '-i', inputPath];
    if (ttsEnabled) inputs.push('-i', ttsNormPath);

    const videoArgs = [
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-r',
      String(Math.round(fps * 1000) / 1000),
    ];

    const audioArgs = this.buildAudioArgs(
      ttsEnabled,
      hasAudio,
      policy,
      advancedKeepWithTts,
      duckDb,
      outputPath,
    );

    return [...inputs, ...videoArgs, ...audioArgs];
  }

  private buildAudioArgs(
    ttsEnabled: boolean,
    hasAudio: boolean,
    policy: string,
    advancedKeepWithTts: boolean,
    duckDb: number,
    outputPath: string,
  ): string[] {
    if (!ttsEnabled) {
      return [
        ...(!hasAudio || policy === 'MUTE' ? ['-an'] : ['-c:a', 'copy']),
        outputPath,
      ];
    }

    const effectivePolicy = hasAudio
      ? policy
      : policy === 'KEEP' || policy === 'DUCK'
        ? 'REPLACE'
        : policy;

    switch (effectivePolicy) {
      case 'REPLACE':
      case 'MUTE':
        return [
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          outputPath,
        ];

      case 'DUCK':
        return [
          '-filter_complex',
          `[0:a]volume=${duckDb}dB[a0];[a0][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`,
          '-map',
          '0:v:0',
          '-map',
          '[a]',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          outputPath,
        ];

      case 'KEEP':
      default:
        if (!advancedKeepWithTts) {
          return [
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            outputPath,
          ];
        }
        return [
          '-filter_complex',
          `[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]`,
          '-map',
          '0:v:0',
          '-map',
          '[a]',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          outputPath,
        ];
    }
  }
}
