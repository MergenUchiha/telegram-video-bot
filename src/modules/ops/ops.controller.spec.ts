import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RenderSessionState } from '@prisma/client';
import { AutonomyService } from '../autonomy/autonomy.service';
import { QueuesService } from '../queues/queues.service';
import { ProgressService } from '../redis/progress.service';
import { SessionsService } from '../sessions/sessions.service';
import { StorageService } from '../storage/storage.service';
import { OpsController } from './ops.controller';

describe('OpsController', () => {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'OPS_API_TOKEN') return 'ops-token';
      if (key === 'AUTONOMY_OPS_CHAT_ID') return 'ops-chat';
      return undefined;
    }),
  } as unknown as ConfigService;

  const sessions = {
    createSpanishJokesSession: jest
      .fn()
      .mockResolvedValue({ id: 'session-1', progress: 0 }),
    setTextCardPreset: jest.fn().mockResolvedValue(undefined),
    setFixedBackgroundVideoKey: jest.fn().mockResolvedValue(undefined),
    setFixedBackgroundMusicKey: jest.fn().mockResolvedValue(undefined),
    setJokeText: jest.fn().mockResolvedValue(undefined),
    setJokeSourceUrl: jest.fn().mockResolvedValue(undefined),
    setAutoPublishYoutube: jest.fn().mockResolvedValue(undefined),
    setState: jest.fn().mockResolvedValue(undefined),
  } as unknown as SessionsService;

  const queues = {
    enqueueRender: jest.fn().mockResolvedValue({ id: 'job-1' }),
  } as unknown as QueuesService;

  const progress = {
    setStatus: jest.fn().mockResolvedValue(undefined),
    setProgress: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProgressService;

  const storage = {} as StorageService;

  const autonomy = {
    ensureSystemOwner: jest.fn().mockResolvedValue({
      id: 'user-1',
      telegramChatId: 'owner-chat',
      telegramUserId: 'system:autonomy:main',
    }),
  } as unknown as AutonomyService;

  const controller = new OpsController(
    config,
    sessions,
    queues,
    progress,
    storage,
    autonomy,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates and queues a test render session', async () => {
    const response = await controller.createTestVideo('Bearer ops-token', {
      preset: 'light',
      jokeText: 'Este es un chiste de prueba',
      deliveryChatId: 'custom-chat',
    });

    expect(response).toMatchObject({
      sessionId: 'session-1',
      jobId: 'job-1',
      deliveryChatId: 'custom-chat',
      statusUrl: '/ops/test-video/session-1',
    });
    expect(sessions.createSpanishJokesSession).toHaveBeenCalledWith('user-1');
    expect(sessions.setTextCardPreset).toHaveBeenCalledWith('session-1', 'light');
    expect(sessions.setJokeText).toHaveBeenCalledWith(
      'session-1',
      'Este es un chiste de prueba',
    );
    expect(sessions.setState).toHaveBeenCalledWith(
      'session-1',
      RenderSessionState.RENDER_QUEUED,
    );
    expect(queues.enqueueRender).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'user-1',
      chatId: 'custom-chat',
    });
  });

  it('rejects an invalid token', async () => {
    await expect(
      controller.createTestVideo('Bearer wrong-token', {}),
    ).rejects.toThrow(UnauthorizedException);
  });
});
