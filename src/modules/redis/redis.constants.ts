export const REDIS_CONNECTION = 'REDIS_CONNECTION';

export const QUEUE_RENDER = 'render';

export const REDIS_KEYS = {
  // “одно видео за раз” — глобально или на пользователя
  userActiveLock: (userId: string) => `lock:user:${userId}:active_render`,
  globalActiveLock: () => `lock:global:active_render`,

  // быстрый статус/прогресс (для /status и кнопок)
  sessionStatus: (sessionId: string) => `session:${sessionId}:status`,
  sessionProgress: (sessionId: string) => `session:${sessionId}:progress`,

  // маркеры идемпотентности/результатов (не обяз., но полезно)
  sessionOutputKey: (sessionId: string) => `session:${sessionId}:output_key`,
  sessionLastError: (sessionId: string) => `session:${sessionId}:last_error`,
} as const;

export type SessionState =
  | 'WAIT_VIDEO'
  | 'WAIT_TEXT_OR_SETTINGS'
  | 'READY_TO_RENDER'
  | 'RENDER_QUEUED'
  | 'RENDERING'
  | 'RENDER_DONE'
  | 'RENDER_FAILED';