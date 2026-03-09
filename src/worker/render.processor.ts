import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentMode, RenderSessionState } from '@prisma/client';
import { execa } from 'execa';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';

import { QUEUE_RENDER } from '../modules/redis/redis.constants';
import { SessionsService } from '../modules/sessions/sessions.service';
import { StorageService } from '../modules/storage/storage.service';
import { ProgressService } from '../modules/redis/progress.service';
import { LockService } from '../modules/redis/lock.service';
import { TelegramSenderService } from '../modules/telegram-sender/telegram-sender.service';
import { TtsService } from '../modules/tts/tts.service';
import { MediaProbeService } from '../modules/media-probe/media-probe.service';
import { SubtitlesService } from '../modules/subtitles/subtitles.service';
import { MetricsService } from '../modules/metrics/metrics.service';
import { UsedJokesService } from '../modules/jokes/used-jokes.service';
import { JokesCacheService } from '../modules/jokes/jokes-cache.service';
import { BackgroundLibraryService } from '../modules/library/background-library.service';
import { MusicLibraryService } from '../modules/library/music-library.service';
import { QueuesService } from '../modules/queues/queues.service';
import { AutonomyService } from '../modules/autonomy/autonomy.service';
import {
  TextCardService,
  TextCardPreset,
} from '../modules/text-card/text-card.service';

type RenderJobPayload = { sessionId: string; userId: string; chatId: string };

@Processor(QUEUE_RENDER, { concurrency: 1 })
export class RenderProcessor extends WorkerHost {
  private readonly logger = new Logger('RenderProcessor');

  constructor(
    private readonly sessions: SessionsService,
    private readonly storage: StorageService,
    private readonly progress: ProgressService,
    private readonly lock: LockService,
    private readonly config: ConfigService,
    private readonly tg: TelegramSenderService,
    private readonly tts: TtsService,
    private readonly probe: MediaProbeService,
    private readonly subs: SubtitlesService,
    private readonly metrics: MetricsService,
    private readonly usedJokes: UsedJokesService,
    private readonly jokesCache: JokesCacheService,
    private readonly bgLibrary: BackgroundLibraryService,
    private readonly musicLibrary: MusicLibraryService,
    private readonly textCard: TextCardService,
    private readonly queues: QueuesService,
    private readonly autonomy: AutonomyService,
  ) {
    super();
    this.logger.log('RenderProcessor initialized');
  }

  async process(job: Job<RenderJobPayload>): Promise<void> {
    const { sessionId, userId, chatId } = job.data;
    const startedAt = new Date();
    let session: any = null;

    const tmpRoot =
      this.config.get<string>('RENDER_TMP_DIR') ||
      path.join(os.tmpdir(), 'renderer');
    const ffmpegPath = this.config.get<string>('FFMPEG_PATH') || 'ffmpeg';
    const outW = Number(this.config.get<string>('OUTPUT_WIDTH', '1080'));
    const outH = Number(this.config.get<string>('OUTPUT_HEIGHT', '1920'));
    const renderTimeoutMs = Number(
      this.config.get<string>('RENDER_TIMEOUT_MS') || '1200000',
    );
    const configDuckDb = Number(
      this.config.get<string>('DEFAULT_DUCK_DB') || '-18',
    );

    const tmpDir = path.join(tmpRoot, sessionId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const clip = (s: any, max = 1800) => {
      const str = String(s ?? '');
      return str.length <= max ? str : `…(truncated)\n${str.slice(-max)}`;
    };

    // ── Distributed lock ──────────────────────────────────────────────────
    const lockResult = await this.lock.acquireUserRenderLock(userId, sessionId);
    if (!lockResult.ok) {
      throw new Error(
        `Lock busy for user ${userId}, session ${sessionId} — retry later`,
      );
    }
    const lockKey = lockResult.key;

    const lockRefreshInterval = setInterval(async () => {
      const ok = await this.lock.refreshLock(lockKey, sessionId);
      if (!ok)
        this.logger.warn(`Lock lost mid-render for session ${sessionId}`);
    }, 60_000);

    try {
      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'Воркер принял задачу',
      });
      await this.progress.setProgress(sessionId, 5);

      session = await this.sessions.getSessionById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if ((session as any).triggerSource === 'AUTONOMOUS') {
        await this.autonomy.markRunRenderingBySession(sessionId).catch(() => {});
      }

      // ── Роутинг по режиму ─────────────────────────────────────────────
      if ((session as any).contentMode === ContentMode.SPANISH_JOKES_AUTO) {
        await this.processSpanishJokesAuto(
          session,
          userId,
          chatId,
          tmpDir,
          ffmpegPath,
          outW,
          outH,
          renderTimeoutMs,
          startedAt,
        );
      } else {
        await this.processStandard(
          session,
          userId,
          chatId,
          tmpDir,
          ffmpegPath,
          outW,
          outH,
          renderTimeoutMs,
          configDuckDb,
          startedAt,
        );
      }
    } catch (e: any) {
      const msg = clip(e?.message || String(e), 1600);
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      await this.progress.setLastError(sessionId, msg);

      if (!finalAttempt) {
        await this.progress.setStatus(sessionId, {
          state: 'RENDERING',
          updatedAt: new Date().toISOString(),
          message: `Retrying after error (${job.attemptsMade + 1}/${job.opts.attempts ?? 1})`,
        });
        throw e;
      }

      const finishedAt = new Date();

      await this.progress.setStatus(sessionId, {
        state: 'RENDER_FAILED',
        updatedAt: new Date().toISOString(),
        message: msg,
      });
      try {
        await this.sessions.setState(
          sessionId,
          RenderSessionState.RENDER_FAILED,
        );
      } catch {}

      if ((session as any)?.triggerSource === 'AUTONOMOUS') {
        await this.autonomy.markRunFailedBySession(sessionId, msg).catch(() => {});
      }

      await this.metrics
        .recordJobFailed({
          sessionId,
          durationMs: new Date().getTime() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          error: msg.slice(0, 500),
        })
        .catch(() => {});

      await this.tg
        .sendMessage(
          chatId,
          `❌ Рендер завершился с ошибкой:\n${msg.slice(0, 1000)}`,
        )
        .catch(() => {});

      throw e;
    } finally {
      clearInterval(lockRefreshInterval);
      await this.lock.releaseLock(lockKey, sessionId).catch(() => {});
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // STANDARD RENDER
  // ════════════════════════════════════════════════════════════════════════

  private async processStandard(
    session: any,
    userId: string,
    chatId: string,
    tmpDir: string,
    ffmpegPath: string,
    outW: number,
    outH: number,
    renderTimeoutMs: number,
    configDuckDb: number,
    startedAt: Date,
  ): Promise<void> {
    const sessionId = session.id;

    if (!session.sourceVideoKey) throw new Error('sourceVideoKey missing');

    const inPath = path.join(tmpDir, 'input.mp4');
    const outPath = path.join(tmpDir, 'out.mp4');
    const ttsWav = path.join(tmpDir, 'tts.wav');
    const ttsNormWav = path.join(tmpDir, 'tts_norm.wav');
    const srtPath = path.join(tmpDir, 'subs.srt');
    const assPath = path.join(tmpDir, 'subs.ass');
    const overlayTextFile = path.join(tmpDir, 'overlay.txt');

    const duckDb =
      typeof session.customDuckDb === 'number'
        ? session.customDuckDb
        : configDuckDb;

    await this.storage.downloadToFile(session.sourceVideoKey, inPath);
    await this.progress.setProgress(sessionId, 15);

    const meta = await this.probe.probe(inPath);
    const fps = meta.fps || 30;
    const hasAudio = meta.hasAudio;

    await this.progress.setProgress(sessionId, 20);

    // ── VIDEO FILTER ──────────────────────────────────────────────────────
    const base = `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`;
    let vf = base;

    const overlayEnabled = Boolean(session.overlayEnabled);
    const overlayComment = session.overlayComment as string | null;

    if (overlayEnabled && overlayComment) {
      const fontPath = this.config.get<string>(
        'FONT_PATH',
        'C:\\Windows\\Fonts\\arial.ttf',
      );
      const wrapped = this.wrapText(overlayComment.toUpperCase(), 22);
      await fs.promises.writeFile(overlayTextFile, wrapped, 'utf-8');
      const fontEsc = fontPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
      const textFileEsc = overlayTextFile
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:');
      vf =
        `${vf},drawtext=fontfile='${fontEsc}':` +
        `textfile='${textFileEsc}':` +
        `fontcolor=black:fontsize=72:line_spacing=14:` +
        `box=1:boxcolor=white@0.85:boxborderw=36:` +
        `shadowcolor=black@0.25:shadowx=2:shadowy=2:` +
        `x=(w-text_w)/2:y=h-text_h-160`;
    }

    // ── TTS + SUBS ────────────────────────────────────────────────────────
    const ttsEnabled = Boolean(session.ttsEnabled);
    const ttsText = (session.ttsText as string | null)?.trim() || '';
    const subtitlesMode =
      (session.subtitlesMode as 'NONE' | 'HARD' | 'SOFT') ?? 'NONE';

    if (ttsEnabled) {
      if (!ttsText) throw new Error('TTS включён, но ttsText пуст');

      await this.progress.setStatus(sessionId, {
        state: 'RENDERING',
        updatedAt: new Date().toISOString(),
        message: 'Генерирую TTS...',
      });

      await this.tts.synthesizeToWav(ttsWav, {
        text: ttsText,
        language: session.language ?? null,
        voiceId: session.voiceId ?? null,
        speed: session.ttsSpeed ?? null,
      });

      await this.progress.setProgress(sessionId, 35);
      await this.runFfmpeg(
        ffmpegPath,
        [
          '-y',
          '-i',
          ttsWav,
          '-af',
          'loudnorm=I=-16:LRA=11:TP=-1.5',
          ttsNormWav,
        ],
        renderTimeoutMs,
      );
      await this.progress.setProgress(sessionId, 45);

      if (subtitlesMode === 'HARD') {
        await this.progress.setStatus(sessionId, {
          state: 'RENDERING',
          updatedAt: new Date().toISOString(),
          message: 'Генерирую субтитры...',
        });
        await this.subs.makeSrt(srtPath, ttsText, meta.durationSec || 10);
        await this.subs.srtToAss(assPath, srtPath);
        const assEsc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
        vf = `${vf},ass='${assEsc}'`;
        await this.progress.setProgress(sessionId, 55);
      }
    }

    // ── AUDIO POLICY ─────────────────────────────────────────────────────
    const policy =
      (session.originalAudioPolicy as 'REPLACE' | 'DUCK' | 'MUTE' | 'KEEP') ??
      'KEEP';
    const advancedKeepWithTts = Boolean(session.advancedKeepWithTts);

    const inputs: string[] = ['-y', '-i', inPath];
    if (ttsEnabled) inputs.push('-i', ttsNormWav);

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
    const outArgs: string[] = [];

    if (!ttsEnabled) {
      outArgs.push(
        ...(!hasAudio || policy === 'MUTE' ? ['-an'] : ['-c:a', 'copy']),
        outPath,
      );
    } else {
      const eff = hasAudio
        ? policy
        : policy === 'KEEP' || policy === 'DUCK'
          ? 'REPLACE'
          : policy;

      if (eff === 'REPLACE' || eff === 'MUTE') {
        outArgs.push(
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          outPath,
        );
      } else if (eff === 'DUCK') {
        outArgs.push(
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
          outPath,
        );
      } else {
        // KEEP
        if (!advancedKeepWithTts) {
          outArgs.push(
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            outPath,
          );
        } else {
          outArgs.push(
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
            outPath,
          );
        }
      }
    }

    await this.progress.setProgress(sessionId, 70);
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'FFmpeg обрабатывает...',
    });

    await this.runFfmpeg(
      ffmpegPath,
      [...inputs, ...videoArgs, ...outArgs],
      renderTimeoutMs,
    );
    await this.progress.setProgress(sessionId, 80);

    await this.finalizeSessionOutput(session, chatId, outPath, startedAt);
  }

  // ════════════════════════════════════════════════════════════════════════
  // SPANISH JOKES AUTO RENDER
  // ════════════════════════════════════════════════════════════════════════

  private async processSpanishJokesAuto(
    session: any,
    userId: string,
    chatId: string,
    tmpDir: string,
    ffmpegPath: string,
    outW: number,
    outH: number,
    renderTimeoutMs: number,
    startedAt: Date,
  ): Promise<void> {
    const sessionId = session.id;
    const defaultAutoDurationSec = Math.max(
      10,
      Number(this.config.get<string>('AUTO_VIDEO_DURATION_SEC', '30')) || 30,
    );

    // ── Шаг 1: Парсинг анекдота ────────────────────────────────────────────
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Получаю анекдот...',
    });
    await this.progress.setProgress(sessionId, 10);

    let jokeText =
      typeof session.jokeText === 'string' && session.jokeText.trim()
        ? session.jokeText.trim()
        : null;

    if (!jokeText) {
      // Берём пул из Redis (без TTL — живёт до исчерпания)
      let jokes = await this.jokesCache.getPool();
      if (!jokes.length) throw new Error('Нет доступных анекдотов');

      // pickUnused возвращает { joke, poolExhausted }
      let pickResult = await this.usedJokes.pickUnused(userId, jokes);
      if (!pickResult) throw new Error('Не удалось выбрать анекдот');

      if (pickResult.poolExhausted) {
        // Все анекдоты использованы → грузим свежий пул с сайтов
        this.logger.log(
          `[${sessionId}] Pool exhausted — fetching fresh jokes from web...`,
        );
        await this.progress.setStatus(sessionId, {
          state: 'RENDERING',
          updatedAt: new Date().toISOString(),
          message: 'Пул анекдотов исчерпан, загружаю новые...',
        });

        jokes = await this.jokesCache.refreshCache();
        await this.usedJokes.reset(userId); // сбрасываем историю под новый пул

        pickResult = await this.usedJokes.pickUnused(userId, jokes);
        if (!pickResult)
          throw new Error('Не удалось выбрать анекдот после обновления пула');

        this.logger.log(`[${sessionId}] Fresh pool loaded: ${jokes.length} jokes`);
      }

      jokeText = pickResult.joke;
    } else {
      this.logger.log(`[${sessionId}] Using prefilled joke text from session`);
    }

    // Сохраняем текст анекдота в сессию для истории
    await this.sessions.setJokeText(sessionId, jokeText);
    if ((session as any).autonomousRunId) {
      await this.autonomy
        .setRunJokeSnapshot((session as any).autonomousRunId, jokeText)
        .catch(() => {});
    }
    this.logger.log(
      `[${sessionId}] Joke selected: ${jokeText.slice(0, 60)}...`,
    );

    // ── Шаг 2: Выбор фонового видео ───────────────────────────────────────
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Выбираю фоновое видео...',
    });
    await this.progress.setProgress(sessionId, 20);

    // Приоритет выбора видео:
    // 1. fixedBackgroundVideoKey — явный выбор пользователя через бот
    // 2. sourceVideoKey          — видео загруженное пользователем вручную
    // 3. pickRandom()            — случайное из библиотеки
    let bgVideoKey: string | null =
      (session as any).fixedBackgroundVideoKey ??
      session.sourceVideoKey ??
      null;
    if (!bgVideoKey) {
      bgVideoKey = await this.bgLibrary.pickRandom();
    }
    if (bgVideoKey) {
      await this.sessions.setBackgroundVideoKey(sessionId, bgVideoKey);
    }

    // ── Шаг 3: Выбор музыки ───────────────────────────────────────────────
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Выбираю музыку...',
    });
    await this.progress.setProgress(sessionId, 30);

    // Приоритет выбора музыки:
    // 1. fixedBackgroundMusicKey — явный выбор пользователя через бот
    // 2. pickRandom()            — случайная из библиотеки
    const fixedMusicKey = (session as any).fixedBackgroundMusicKey as
      | string
      | null;
    const musicKey = fixedMusicKey ?? (await this.musicLibrary.pickRandom());
    if (musicKey) {
      await this.sessions.setBackgroundMusicKey(sessionId, musicKey);
    } else {
      this.logger.warn(
        `[${sessionId}] Music library empty, rendering without music`,
      );
    }

    // ── Шаг 4: Скачиваем файлы ───────────────────────────────────────────
    const bgPath = path.join(tmpDir, 'bg.mp4');
    const musicPath = path.join(tmpDir, 'music.mp3');
    const cardAssPath = path.join(tmpDir, 'joke_card.ass');
    const outPath = path.join(tmpDir, 'out.mp4');

    if (bgVideoKey) {
      await this.storage.downloadToFile(bgVideoKey, bgPath);
    } else {
      await this.buildGeneratedAutoBackground(
        ffmpegPath,
        bgPath,
        outW,
        outH,
        defaultAutoDurationSec,
        renderTimeoutMs,
      );
      this.logger.warn(
        `[${sessionId}] Background library empty, using generated fallback background`,
      );
    }
    await this.progress.setProgress(sessionId, 40);

    let hasMusicFile = false;
    if (musicKey) {
      await this.storage.downloadToFile(musicKey, musicPath);
      hasMusicFile = true;
    }

    // ── Шаг 5: Пробуем фоновое видео ─────────────────────────────────────
    const meta = await this.probe.probe(bgPath);
    const fps = meta.fps || 30;
    const durationSec = meta.durationSec || defaultAutoDurationSec;

    // ── Шаг 6: Генерируем текстовую карточку ─────────────────────────────
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'Генерирую текстовую карточку...',
    });
    await this.progress.setProgress(sessionId, 50);

    const preset =
      ((session as any).textCardPreset as TextCardPreset) || 'default';
    await this.textCard.makeJokeCard(
      cardAssPath,
      jokeText,
      durationSec,
      preset,
    );

    // ── Шаг 7: Сборка FFmpeg ──────────────────────────────────────────────
    await this.progress.setStatus(sessionId, {
      state: 'RENDERING',
      updatedAt: new Date().toISOString(),
      message: 'FFmpeg собирает ролик...',
    });
    await this.progress.setProgress(sessionId, 65);

    const cardAssEsc = cardAssPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

    if (hasMusicFile) {
      await this.buildSpanishJokesWithMusic(
        ffmpegPath,
        bgPath,
        musicPath,
        cardAssEsc,
        outPath,
        outW,
        outH,
        fps,
        durationSec,
        renderTimeoutMs,
      );
    } else {
      await this.buildSpanishJokesNoMusic(
        ffmpegPath,
        bgPath,
        cardAssEsc,
        outPath,
        outW,
        outH,
        fps,
        durationSec,
        renderTimeoutMs,
      );
    }

    await this.progress.setProgress(sessionId, 85);

    // ── Шаг 9: (markUsed уже вызван внутри pickUnused — до рендера) Загрузка и отправка ───────────────────────────────────────
    await this.finalizeSessionOutput(session, chatId, outPath, startedAt);

    // ── Шаг 10: Авто-публикация на YouTube (если включено) ───────────────
    if (
      (session as any).autoPublishYoutube &&
      (session as any).triggerSource !== 'AUTONOMOUS'
    ) {
      await this.triggerYoutubeAutoPublish(session, userId, chatId);
    }
  }

  /**
   * FFmpeg: фон + музыка + текстовая карточка
   *
   * Логика:
   *   - background.mp4 зациклен через -stream_loop -1, обрезается по длительности
   *   - музыка зациклена и обрезается по той же длительности
   *   - текстовая карточка прожигается через ASS-фильтр
   *   - итог: чистое видео с карточкой и фоновой музыкой
   */
  private async buildSpanishJokesWithMusic(
    ffmpegPath: string,
    bgPath: string,
    musicPath: string,
    cardAssEsc: string,
    outPath: string,
    outW: number,
    outH: number,
    fps: number,
    durationSec: number,
    renderTimeoutMs: number,
  ): Promise<void> {
    const musicVolumeDb = this.config.get<string>('MUSIC_VOLUME_DB') || '-18';
    const duration = String(Math.round(durationSec * 100) / 100);
    const roundFps = String(Math.round(fps * 1000) / 1000);

    const filterComplex = [
      // Видеопоток: нормализация + карточка
      `[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},ass='${cardAssEsc}'[v]`,
      // Аудиопоток: обрезать музыку по длительности видео
      `[1:a]volume=${musicVolumeDb}dB,atrim=0:${duration},asetpts=PTS-STARTPTS[a]`,
    ].join(';');

    await this.runFfmpeg(
      ffmpegPath,
      [
        '-y',
        // Фоновое видео (зациклено)
        '-stream_loop',
        '-1',
        '-i',
        bgPath,
        // Музыка (зациклена)
        '-stream_loop',
        '-1',
        '-i',
        musicPath,
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
        outPath,
      ],
      renderTimeoutMs,
    );
  }

  /** FFmpeg: фон + текстовая карточка, без музыки */
  private async buildSpanishJokesNoMusic(
    ffmpegPath: string,
    bgPath: string,
    cardAssEsc: string,
    outPath: string,
    outW: number,
    outH: number,
    fps: number,
    durationSec: number,
    renderTimeoutMs: number,
  ): Promise<void> {
    const duration = String(Math.round(durationSec * 100) / 100);
    const roundFps = String(Math.round(fps * 1000) / 1000);

    await this.runFfmpeg(
      ffmpegPath,
      [
        '-y',
        '-stream_loop',
        '-1',
        '-i',
        bgPath,
        '-vf',
        `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},ass='${cardAssEsc}'`,
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
        outPath,
      ],
      renderTimeoutMs,
    );
  }

  /** Zero-config fallback background for smoke tests and empty libraries. */
  private async buildGeneratedAutoBackground(
    ffmpegPath: string,
    outPath: string,
    outW: number,
    outH: number,
    durationSec: number,
    renderTimeoutMs: number,
  ): Promise<void> {
    const duration = String(Math.max(10, Math.round(durationSec * 100) / 100));

    await this.runFfmpeg(
      ffmpegPath,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x152238:s=${outW}x${outH}:d=${duration}:r=30`,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        outPath,
      ],
      renderTimeoutMs,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // ОБЩИЕ ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
  // ════════════════════════════════════════════════════════════════════════

  /** Загрузить результат в S3 и либо отправить в Telegram, либо передать в YouTube pipeline */
  private async finalizeSessionOutput(
    session: any,
    chatId: string,
    outPath: string,
    startedAt: Date,
  ): Promise<void> {
    const sessionId = session.id;
    const outKey = `outputs/${sessionId}/${randomUUID()}.mp4`;
    await this.storage.uploadFile(outKey, outPath, 'video/mp4');
    await this.sessions.setOutputVideoKey(sessionId, outKey);
    await this.progress.setProgress(sessionId, 90);

    if ((session as any).triggerSource === 'AUTONOMOUS') {
      const runId =
        ((session as any).autonomousRunId as string | null) ??
        (await this.autonomy.getRunBySessionId(sessionId))?.id ??
        null;
      if (!runId) {
        throw new Error(`Autonomous run linkage missing for session ${sessionId}`);
      }

      await this.sessions.setState(sessionId, RenderSessionState.YOUTUBE_UPLOADING);
      await this.progress.setStatus(sessionId, {
        state: 'YOUTUBE_UPLOADING',
        updatedAt: new Date().toISOString(),
        message: 'Render complete, queueing YouTube upload',
      } as any);
      await this.progress.setProgress(sessionId, 95);
      await this.autonomy.markRunYoutubeUploadingBySession(sessionId).catch(() => {});

      await this.queues.enqueueYoutubeUpload({
        sessionId,
        runId,
        opsChatId: chatId,
      });
      await this.tg
        .sendMessage(chatId, `📺 Render complete, starting YouTube upload\nRun: ${runId}`)
        .catch(() => {});
    } else {
      const url = await this.storage.presignGetUrl(outKey);
      let deliveredToTelegram = false;

      if (chatId) {
        try {
          await this.tg.sendVideoFile(chatId, outPath, '✅ Рендер завершён!');
          deliveredToTelegram = true;
        } catch (sendFileError) {
          try {
            await this.tg.sendVideoByUrl(
              chatId,
              url,
              '✅ Рендер завершён! (ссылка)',
            );
            deliveredToTelegram = true;
          } catch (sendUrlError) {
            this.logger.warn(
              `[${sessionId}] Telegram delivery skipped: ${String(
                (sendUrlError as Error)?.message ||
                  (sendFileError as Error)?.message ||
                  sendUrlError,
              )}`,
            );
          }
        }
      }

      await this.sessions.setState(sessionId, RenderSessionState.RENDER_DONE);
      await this.progress.setStatus(sessionId, {
        state: 'RENDER_DONE',
        updatedAt: new Date().toISOString(),
        message: deliveredToTelegram
          ? 'Готово'
          : 'Готово (доступно через ops status endpoint)',
      });
      await this.progress.setProgress(sessionId, 100);
    }

    const finishedAt = new Date();
    await this.metrics
      .recordJobDone({
        sessionId,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      })
      .catch(() => {});
  }

  /**
   * Поставить задачу авто-публикации на YouTube.
   * YouTube-очередь будет реализована в Этапе 5.
   * Пока логируем намерение — заглушка для будущей интеграции.
   */
  private async triggerYoutubeAutoPublish(
    session: any,
    userId: string,
    chatId: string,
  ): Promise<void> {
    this.logger.log(
      `[${session.id}] Auto-publish to YouTube requested for user ${userId}. ` +
        `(YouTube queue will be implemented in Stage 5)`,
    );
    // TODO Stage 5: enqueue youtube job
    // await this.youtubeQueue.enqueue({ sessionId: session.id, userId, chatId, useDefault: true });
    await this.tg
      .sendMessage(
        chatId,
        '📺 Автопубликация на YouTube будет реализована в следующем обновлении.',
      )
      .catch(() => {});
  }

  private async runFfmpeg(
    ffmpegPath: string,
    args: string[],
    timeoutMs: number,
  ) {
    try {
      const res = await execa(ffmpegPath, args, {
        all: true,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      if (res.all) this.logger.debug(res.all);
    } catch (e: any) {
      const all = e?.all ? String(e.all) : '';
      const clip = (s: string, max = 2400) =>
        s.length <= max ? s : `…\n${s.slice(-max)}`;
      const merged = all?.trim()
        ? `${e?.message}\n\nffmpeg output:\n${clip(all, 2400)}`
        : String(e?.message);
      this.logger.error(clip(merged, 2400));
      throw new Error(clip(merged, 2400));
    }
  }

  private wrapText(text: string, maxLineLen = 22): string {
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
