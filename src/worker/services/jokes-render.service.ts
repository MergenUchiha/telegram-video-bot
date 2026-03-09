import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import type { RenderSession } from '@prisma/client';
import { FfmpegService } from './ffmpeg.service';
import { StorageService } from '../../modules/storage/storage.service';
import { ProgressService } from '../../modules/redis/progress.service';
import { MediaProbeService } from '../../modules/media-probe/media-probe.service';
import { TextCardService } from '../../modules/text-card/text-card.service';
import { BackgroundLibraryService } from '../../modules/library/background-library.service';
import { MusicLibraryService } from '../../modules/library/music-library.service';
import { JokesCacheService } from '../../modules/jokes/jokes-cache.service';
import { UsedJokesService } from '../../modules/jokes/used-jokes.service';
import { SessionsService } from '../../modules/sessions/sessions.service';

export interface JokesRenderOptions {
  session: RenderSession;
  userId: string;
  tmpDir: string;
}

export interface JokesRenderResult {
  outputPath: string;
  jokeText: string;
}

@Injectable()
export class JokesRenderService {
  private readonly logger = new Logger(JokesRenderService.name);

  constructor(
    private readonly ffmpeg: FfmpegService,
    private readonly storage: StorageService,
    private readonly progress: ProgressService,
    private readonly probe: MediaProbeService,
    private readonly textCard: TextCardService,
    private readonly bgLibrary: BackgroundLibraryService,
    private readonly musicLibrary: MusicLibraryService,
    private readonly jokesCache: JokesCacheService,
    private readonly usedJokes: UsedJokesService,
    private readonly sessions: SessionsService,
  ) {}

  async render({
    session,
    userId,
    tmpDir,
  }: JokesRenderOptions): Promise<JokesRenderResult> {
    const sessionId = session.id;

    const jokeText = await this.pickJoke(sessionId, userId);
    await this.sessions.setJokeText(sessionId, jokeText);
    this.logger.log(
      `[${sessionId}] Joke selected: ${jokeText.slice(0, 60)}...`,
    );

    const bgVideoKey = await this.resolveBackgroundVideo(session, sessionId);
    const musicKey = await this.resolveMusicTrack(session, sessionId);

    const paths = this.buildPaths(tmpDir);

    await this.storage.downloadToFile(bgVideoKey, paths.bg);
    await this.progress.setProgress(sessionId, 40);

    let hasMusicFile = false;
    if (musicKey) {
      await this.storage.downloadToFile(musicKey, paths.music);
      hasMusicFile = true;
    }

    const meta = await this.probe.probe(paths.bg);
    const fps = meta.fps || 30;
    const durationSec = meta.durationSec || 30;

    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Генерирую текстовую карточку...',
    });
    await this.progress.setProgress(sessionId, 50);

    const preset = (session.textCardPreset as any) ?? 'default';
    await this.textCard.makeJokeCard(
      paths.cardAss,
      jokeText,
      durationSec,
      preset,
    );

    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'FFmpeg собирает ролик...',
    });
    await this.progress.setProgress(sessionId, 65);

    if (hasMusicFile) {
      await this.renderWithMusic(paths, fps, durationSec);
    } else {
      await this.renderWithoutMusic(paths, fps, durationSec);
    }

    await this.progress.setProgress(sessionId, 85);

    return { outputPath: paths.output, jokeText };
  }

  private async pickJoke(sessionId: string, userId: string): Promise<string> {
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Получаю анекдот...',
    });
    await this.progress.setProgress(sessionId, 10);

    let jokes = await this.jokesCache.getPool();
    if (!jokes.length) throw new Error('Нет доступных анекдотов');

    let pickResult = await this.usedJokes.pick(userId, jokes);
    if (!pickResult) throw new Error('Не удалось выбрать анекдот');

    if (pickResult.poolExhausted) {
      this.logger.log(
        `[${sessionId}] Pool exhausted — fetching fresh jokes from web...`,
      );
      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'Пул анекдотов исчерпан, загружаю новые...',
      });
      jokes = await this.jokesCache.refreshCache();
      await this.usedJokes.reset(userId);
      pickResult = await this.usedJokes.pick(userId, jokes);
      if (!pickResult)
        throw new Error('Не удалось выбрать анекдот после обновления пула');
      this.logger.log(
        `[${sessionId}] Fresh pool loaded: ${jokes.length} jokes`,
      );
    }

    return pickResult.joke;
  }

  private async resolveBackgroundVideo(
    session: RenderSession,
    sessionId: string,
  ): Promise<string> {
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Выбираю фоновое видео...',
    });
    await this.progress.setProgress(sessionId, 20);

    const bgVideoKey =
      session.fixedBackgroundVideoKey ??
      session.sourceVideoKey ??
      (await this.bgLibrary.pickRandom());

    if (!bgVideoKey) {
      throw new Error(
        'Библиотека фоновых видео пуста. Загрузи видео через /library.',
      );
    }

    await this.sessions.setBackgroundVideoKey(sessionId, bgVideoKey);
    return bgVideoKey;
  }

  private async resolveMusicTrack(
    session: RenderSession,
    sessionId: string,
  ): Promise<string | null> {
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Выбираю музыку...',
    });
    await this.progress.setProgress(sessionId, 30);

    const musicKey =
      session.fixedBackgroundMusicKey ?? (await this.musicLibrary.pickRandom());

    if (musicKey) {
      await this.sessions.setBackgroundMusicKey(sessionId, musicKey);
    } else {
      this.logger.warn(
        `[${session.id}] Music library empty, rendering without music`,
      );
    }

    return musicKey;
  }

  private buildPaths(tmpDir: string) {
    return {
      bg: path.join(tmpDir, 'bg.mp4'),
      music: path.join(tmpDir, 'music.mp3'),
      cardAss: path.join(tmpDir, 'joke_card.ass'),
      output: path.join(tmpDir, 'out.mp4'),
    };
  }

  private async renderWithMusic(
    paths: ReturnType<typeof this.buildPaths>,
    fps: number,
    durationSec: number,
  ): Promise<void> {
    const { outputWidth: w, outputHeight: h } = this.ffmpeg;
    const duration = String(Math.round(durationSec * 100) / 100);
    const roundFps = String(Math.round(fps * 1000) / 1000);
    const cardAssEsc = this.ffmpeg.escapeFilterPath(paths.cardAss);
    const musicVolumeDb = this.ffmpeg.musicVolumeDb;

    const filterComplex = [
      `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},ass='${cardAssEsc}'[v]`,
      `[1:a]volume=${musicVolumeDb}dB,atrim=0:${duration},asetpts=PTS-STARTPTS[a]`,
    ].join(';');

    await this.ffmpeg.run([
      '-y',
      '-stream_loop',
      '-1',
      '-i',
      paths.bg,
      '-stream_loop',
      '-1',
      '-i',
      paths.music,
      '-filter_complex',
      filterComplex,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-r',
      roundFps,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-t',
      duration,
      paths.output,
    ]);
  }

  private async renderWithoutMusic(
    paths: ReturnType<typeof this.buildPaths>,
    fps: number,
    durationSec: number,
  ): Promise<void> {
    const { outputWidth: w, outputHeight: h } = this.ffmpeg;
    const duration = String(Math.round(durationSec * 100) / 100);
    const roundFps = String(Math.round(fps * 1000) / 1000);
    const cardAssEsc = this.ffmpeg.escapeFilterPath(paths.cardAss);

    await this.ffmpeg.run([
      '-y',
      '-stream_loop',
      '-1',
      '-i',
      paths.bg,
      '-vf',
      `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},ass='${cardAssEsc}'`,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-r',
      roundFps,
      '-t',
      duration,
      paths.output,
    ]);
  }
}
