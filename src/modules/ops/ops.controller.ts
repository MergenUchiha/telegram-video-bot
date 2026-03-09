import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RenderSessionState } from '@prisma/client';
import { AutonomyService } from '../autonomy/autonomy.service';
import { clipError } from '../autonomy/autonomy.utils';
import { QueuesService } from '../queues/queues.service';
import { ProgressService } from '../redis/progress.service';
import { SessionsService } from '../sessions/sessions.service';
import { StorageService } from '../storage/storage.service';
import { TextCardPreset } from '../text-card/text-card.service';

const TEXT_CARD_PRESETS: TextCardPreset[] = [
  'default',
  'dark',
  'light',
  'minimal',
];

@Controller('ops')
export class OpsController {
  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionsService,
    private readonly queues: QueuesService,
    private readonly progress: ProgressService,
    private readonly storage: StorageService,
    private readonly autonomy: AutonomyService,
  ) {}

  @Get('health')
  getHealth() {
    return {
      ok: true,
      service: 'telegram-video-bot',
      timestamp: new Date().toISOString(),
    };
  }

  @Post('test-video')
  async createTestVideo(
    @Headers('authorization') auth: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    this.assertAuthorized(auth);

    const owner = await this.autonomy.ensureSystemOwner();
    const preset = this.parsePreset(body['preset']);
    const fixedBackgroundVideoKey = this.parseOptionalString(
      body,
      'fixedBackgroundVideoKey',
    );
    const fixedBackgroundMusicKey = this.parseOptionalString(
      body,
      'fixedBackgroundMusicKey',
    );
    const deliveryChatId =
      this.parseOptionalString(body, 'deliveryChatId') ||
      this.config.get<string>('AUTONOMY_OPS_CHAT_ID') ||
      owner.telegramChatId ||
      '0';
    const jokeText = this.parseNullableString(body, 'jokeText');
    const jokeSourceUrl = this.parseNullableString(body, 'jokeSourceUrl');

    const session = await this.sessions.createSpanishJokesSession(owner.id);

    if (preset) {
      await this.sessions.setTextCardPreset(session.id, preset);
    }
    if (fixedBackgroundVideoKey !== undefined) {
      await this.sessions.setFixedBackgroundVideoKey(
        session.id,
        fixedBackgroundVideoKey,
      );
    }
    if (fixedBackgroundMusicKey !== undefined) {
      await this.sessions.setFixedBackgroundMusicKey(
        session.id,
        fixedBackgroundMusicKey,
      );
    }
    if (jokeText) {
      await this.sessions.setJokeText(session.id, jokeText);
    }
    if (jokeSourceUrl !== undefined) {
      await this.sessions.setJokeSourceUrl(session.id, jokeSourceUrl);
    }

    await this.sessions.setAutoPublishYoutube(session.id, false);
    await this.sessions.setState(session.id, RenderSessionState.RENDER_QUEUED);
    await this.progress.setStatus(session.id, {
      state: 'RENDER_QUEUED',
      updatedAt: new Date().toISOString(),
      message: 'Queued from ops API',
    });
    await this.progress.setProgress(session.id, 0);

    const job = await this.queues.enqueueRender({
      sessionId: session.id,
      userId: owner.id,
      chatId: deliveryChatId,
    });

    return {
      sessionId: session.id,
      jobId: job.id,
      deliveryChatId,
      statusUrl: `/ops/test-video/${session.id}`,
      note:
        'The output video will be uploaded to storage. If Telegram delivery is configured, it will also be sent to the delivery chat.',
    };
  }

  @Get('test-video/:sessionId')
  async getTestVideoStatus(
    @Headers('authorization') auth: string,
    @Param('sessionId') sessionId: string,
  ) {
    this.assertAuthorized(auth);

    const session = await this.sessions.getSessionById(sessionId);
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    const [status, progress, lastError] = await Promise.all([
      this.progress.getStatus(sessionId),
      this.progress.getProgress(sessionId),
      this.progress.getLastError(sessionId),
    ]);

    const outputVideoUrl = session.outputVideoKey
      ? await this.storage.presignGetUrl(session.outputVideoKey)
      : null;

    return {
      sessionId: session.id,
      state: session.state,
      contentMode: session.contentMode,
      progress: progress ?? session.progress,
      status,
      lastError: lastError ?? session.lastError,
      outputVideoKey: session.outputVideoKey ?? null,
      outputVideoUrl,
      jokeText: session.jokeText ?? null,
      jokeSourceUrl: session.jokeSourceUrl ?? null,
      backgroundVideoKey: session.backgroundVideoKey ?? null,
      backgroundMusicKey: session.backgroundMusicKey ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private assertAuthorized(authHeader: string | undefined) {
    const token =
      this.config.get<string>('OPS_API_TOKEN') ||
      this.config.get<string>('METRICS_TOKEN');

    if (!token) {
      return;
    }

    const provided = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (provided !== token) {
      throw new UnauthorizedException('Invalid ops token');
    }
  }

  private parsePreset(value: unknown): TextCardPreset | undefined {
    if (value == null || value === '') {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException('preset must be a string');
    }
    const preset = value.trim() as TextCardPreset;
    if (!TEXT_CARD_PRESETS.includes(preset)) {
      throw new BadRequestException(
        `preset must be one of: ${TEXT_CARD_PRESETS.join(', ')}`,
      );
    }
    return preset;
  }

  private parseOptionalString(
    body: Record<string, unknown>,
    field: string,
  ): string | null | undefined {
    if (!(field in body)) {
      return undefined;
    }
    return this.parseNullableString(body, field);
  }

  private parseNullableString(
    body: Record<string, unknown>,
    field: string,
  ): string | null {
    const value = body[field];
    if (value == null || value === '') {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    if (field === 'jokeText' && normalized.length < 5) {
      throw new BadRequestException('jokeText must be at least 5 characters');
    }

    return normalized;
  }
}
