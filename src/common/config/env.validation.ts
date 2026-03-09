import { z } from 'zod';

const coerceNumber = (defaultVal: number) =>
  z.coerce.number().default(defaultVal);

const coerceBool = (defaultVal: boolean) =>
  z
    .string()
    .default(defaultVal ? '1' : '0')
    .transform((v) => v === '1' || v === 'true');

export const envSchema = z.object({
  // ── Telegram ──────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(10, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_API_BASE_URL: z.string().url().default('https://api.telegram.org'),

  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .startsWith('postgresql://', 'DATABASE_URL must be a postgresql:// URI'),

  // ── Redis ─────────────────────────────────────────────────────────────────
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: coerceNumber(6379),
  REDIS_PASSWORD: z.string().default(''),
  REDIS_DB: coerceNumber(0),
  REDIS_TLS: coerceBool(false),

  // ── MinIO / S3 ────────────────────────────────────────────────────────────
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  S3_REGION: z.string().default('eu-central-1'),
  S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY is required'),
  S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY is required'),
  S3_BUCKET: z.string().default('renderer'),
  S3_FORCE_PATH_STYLE: z.string().default('true'),
  S3_PRESIGN_EXPIRES_SECONDS: coerceNumber(1800),

  // ── Kokoro TTS ────────────────────────────────────────────────────────────
  KOKORO_BASE_URL: z.string().url().default('http://localhost:8880'),
  KOKORO_API_PATH: z.string().default('/v1/audio/speech'),
  KOKORO_MODEL: z.string().default('kokoro'),
  KOKORO_VOICE: z.string().default('af_heart'),
  KOKORO_RESPONSE_FORMAT: z
    .enum(['mp3', 'wav', 'flac', 'opus', 'pcm'])
    .default('wav'),
  KOKORO_TIMEOUT_MS: coerceNumber(120000),

  // ── Render worker ─────────────────────────────────────────────────────────
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  FONT_PATH: z
    .string()
    .default('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
  OUTPUT_WIDTH: coerceNumber(1080),
  OUTPUT_HEIGHT: coerceNumber(1920),
  DEFAULT_DUCK_DB: coerceNumber(-18),
  RENDER_TIMEOUT_MS: coerceNumber(1200000),
  RENDER_TMP_DIR: z.string().default('/tmp/renderer'),

  // ── Автоочистка ──────────────────────────────────────────────────────────
  TMP_CLEANUP_AGE_HOURS: coerceNumber(2),
  INPUT_LIFECYCLE_DAYS: coerceNumber(3),
  OUTPUT_LIFECYCLE_DAYS: coerceNumber(7),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_MAX: coerceNumber(30),
  RATE_LIMIT_WINDOW_SEC: coerceNumber(60),
  RATE_LIMIT_UPLOAD_MAX: coerceNumber(5),
  RATE_LIMIT_UPLOAD_WINDOW_SEC: coerceNumber(3600),
  RATE_LIMIT_RENDER_MAX: coerceNumber(10),
  RATE_LIMIT_RENDER_WINDOW_SEC: coerceNumber(86400),

  // ── Метрики ───────────────────────────────────────────────────────────────
  METRICS_TOKEN: z.string().optional(),

  // ── BullMQ ────────────────────────────────────────────────────────────────
  BULLMQ_PREFIX: z.string().default('tvb'),

  // ── Redis lock TTL ────────────────────────────────────────────────────────
  LOCK_TTL_MS: coerceNumber(1800000),

  // ── Ports ─────────────────────────────────────────────────────────────────
  PORT: coerceNumber(3000),
  API_PORT: coerceNumber(3000),
  MINIO_API_PORT: coerceNumber(9000),
  MINIO_CONSOLE_PORT: coerceNumber(9001),

  // ── Jokes ─────────────────────────────────────────────────────────────────
  JOKES_MIN_LENGTH: coerceNumber(40),
  JOKES_MAX_LENGTH: coerceNumber(600),
  JOKES_PAGES_PER_SOURCE: coerceNumber(3),
  JOKES_SOURCES_ENABLED: z.string().default(''),
  JOKES_FETCH_TIMEOUT_MS: coerceNumber(10000),

  // ── Library ───────────────────────────────────────────────────────────────
  MUSIC_VOLUME_DB: z.string().default('-18'),
  ADMIN_TELEGRAM_USER_IDS: z
    .string()
    .min(1, 'ADMIN_TELEGRAM_USER_IDS must contain at least one ID'),

  // ── Encryption ───────────────────────────────────────────────────────────
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  // ── WaitState TTL ─────────────────────────────────────────────────────────
  WAIT_STATE_TTL_SEC: coerceNumber(600),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Валидирует process.env через Zod.
 * Вызывается один раз при старте приложения.
 * При ошибке выбрасывает исключение с понятным сообщением.
 */
export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  • ${e.path.join('.')}: ${e.message}`)
      .join('\n');

    throw new Error(
      `\n❌ Environment validation failed:\n${errors}\n\n` +
        `Check your .env file against .env.example`,
    );
  }

  return result.data;
}
