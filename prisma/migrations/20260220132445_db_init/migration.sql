-- CreateEnum
CREATE TYPE "RenderSessionState" AS ENUM ('WAIT_VIDEO', 'WAIT_TEXT_OR_SETTINGS', 'READY_TO_RENDER', 'RENDER_QUEUED', 'RENDERING', 'RENDER_DONE', 'RENDER_FAILED', 'YOUTUBE_WAIT_CHANNEL', 'YOUTUBE_UPLOADING', 'YOUTUBE_DONE', 'YOUTUBE_FAILED');

-- CreateEnum
CREATE TYPE "SubtitlesMode" AS ENUM ('NONE', 'HARD', 'SOFT');

-- CreateEnum
CREATE TYPE "OriginalAudioPolicy" AS ENUM ('REPLACE', 'DUCK', 'MUTE', 'KEEP');

-- CreateEnum
CREATE TYPE "RenderJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "YoutubeUploadStatus" AS ENUM ('QUEUED', 'UPLOADING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "render_jobs" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "bull_job_id" TEXT,
    "status" "RenderJobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempts_made" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "render_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "render_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state" "RenderSessionState" NOT NULL DEFAULT 'WAIT_VIDEO',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source_video_key" TEXT,
    "output_video_key" TEXT,
    "tts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tts_text" TEXT,
    "language" TEXT,
    "voice_id" TEXT,
    "tts_speed" DOUBLE PRECISION,
    "subtitles_mode" "SubtitlesMode" NOT NULL DEFAULT 'NONE',
    "overlay_enabled" BOOLEAN NOT NULL DEFAULT false,
    "overlay_comment" TEXT,
    "original_audio_policy" "OriginalAudioPolicy" NOT NULL DEFAULT 'DUCK',
    "advanced_keep_with_tts" BOOLEAN NOT NULL DEFAULT false,
    "output_width" INTEGER NOT NULL DEFAULT 1080,
    "output_height" INTEGER NOT NULL DEFAULT 1920,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_bot_message_id" INTEGER,
    "telegram_meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "render_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "telegram_user_id" TEXT NOT NULL,
    "telegram_chat_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_channels" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel_id" TEXT NOT NULL,
    "channel_title" TEXT NOT NULL,
    "encrypted_refresh_token" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "youtube_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_uploads" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "youtube_channel_id" UUID NOT NULL,
    "status" "YoutubeUploadStatus" NOT NULL DEFAULT 'QUEUED',
    "youtube_video_id" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "youtube_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "render_jobs_session_id_idx" ON "render_jobs"("session_id");

-- CreateIndex
CREATE INDEX "render_jobs_status_idx" ON "render_jobs"("status");

-- CreateIndex
CREATE INDEX "render_sessions_user_id_is_active_idx" ON "render_sessions"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "render_sessions_state_idx" ON "render_sessions"("state");

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");

-- CreateIndex
CREATE INDEX "youtube_channels_user_id_idx" ON "youtube_channels"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_channels_user_id_channel_id_key" ON "youtube_channels"("user_id", "channel_id");

-- CreateIndex
CREATE INDEX "youtube_uploads_session_id_idx" ON "youtube_uploads"("session_id");

-- CreateIndex
CREATE INDEX "youtube_uploads_youtube_channel_id_idx" ON "youtube_uploads"("youtube_channel_id");

-- CreateIndex
CREATE INDEX "youtube_uploads_status_idx" ON "youtube_uploads"("status");

-- AddForeignKey
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "render_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "render_sessions" ADD CONSTRAINT "render_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_channels" ADD CONSTRAINT "youtube_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_uploads" ADD CONSTRAINT "youtube_uploads_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "render_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_uploads" ADD CONSTRAINT "youtube_uploads_youtube_channel_id_fkey" FOREIGN KEY ("youtube_channel_id") REFERENCES "youtube_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
