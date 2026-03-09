-- CreateEnum
CREATE TYPE "TriggerSource" AS ENUM ('MANUAL', 'AUTONOMOUS');

-- CreateEnum
CREATE TYPE "YoutubeVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'UNLISTED');

-- CreateEnum
CREATE TYPE "AutonomousDayPlanSource" AS ENUM ('DEFAULT', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "AutonomousDayPlanStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DONE', 'PARTIAL_FAILED', 'FAILED');

-- CreateEnum
CREATE TYPE "AutonomousRunState" AS ENUM ('PLANNED', 'QUEUED', 'RENDERING', 'YOUTUBE_UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "render_sessions"
ADD COLUMN "trigger_source" "TriggerSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "autonomous_run_id" UUID;

-- CreateTable
CREATE TABLE "autonomous_pipelines" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "owner_user_id" UUID NOT NULL,
    "ops_telegram_chat_id" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ashgabat',
    "window_start_minutes" INTEGER NOT NULL DEFAULT 540,
    "window_end_minutes" INTEGER NOT NULL DEFAULT 1260,
    "default_daily_count" INTEGER NOT NULL DEFAULT 5,
    "max_daily_count" INTEGER NOT NULL DEFAULT 12,
    "content_mode" "ContentMode" NOT NULL DEFAULT 'SPANISH_JOKES_AUTO',
    "youtube_visibility" "YoutubeVisibility" NOT NULL DEFAULT 'PUBLIC',
    "title_suffix" TEXT NOT NULL DEFAULT '#shorts',
    "description_footer" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "autonomous_pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autonomous_day_overrides" (
    "id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "plan_date" DATE NOT NULL,
    "target_count" INTEGER NOT NULL,
    "created_by_telegram_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "autonomous_day_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autonomous_day_plans" (
    "id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "plan_date" DATE NOT NULL,
    "target_count" INTEGER NOT NULL,
    "source" "AutonomousDayPlanSource" NOT NULL DEFAULT 'DEFAULT',
    "status" "AutonomousDayPlanStatus" NOT NULL DEFAULT 'PLANNED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "autonomous_day_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "autonomous_runs" (
    "id" UUID NOT NULL,
    "day_plan_id" UUID NOT NULL,
    "slot_index" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "state" "AutonomousRunState" NOT NULL DEFAULT 'PLANNED',
    "render_session_id" UUID,
    "youtube_upload_id" UUID,
    "youtube_video_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "joke_text_snapshot" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "autonomous_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "autonomous_pipelines_key_key" ON "autonomous_pipelines"("key");

-- CreateIndex
CREATE INDEX "autonomous_pipelines_owner_user_id_idx" ON "autonomous_pipelines"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "autonomous_day_overrides_pipeline_id_plan_date_key" ON "autonomous_day_overrides"("pipeline_id", "plan_date");

-- CreateIndex
CREATE INDEX "autonomous_day_overrides_plan_date_idx" ON "autonomous_day_overrides"("plan_date");

-- CreateIndex
CREATE UNIQUE INDEX "autonomous_day_plans_pipeline_id_plan_date_key" ON "autonomous_day_plans"("pipeline_id", "plan_date");

-- CreateIndex
CREATE INDEX "autonomous_day_plans_plan_date_idx" ON "autonomous_day_plans"("plan_date");

-- CreateIndex
CREATE INDEX "autonomous_day_plans_status_idx" ON "autonomous_day_plans"("status");

-- CreateIndex
CREATE UNIQUE INDEX "autonomous_runs_day_plan_id_slot_index_key" ON "autonomous_runs"("day_plan_id", "slot_index");

-- CreateIndex
CREATE INDEX "autonomous_runs_scheduled_at_idx" ON "autonomous_runs"("scheduled_at");

-- CreateIndex
CREATE INDEX "autonomous_runs_state_idx" ON "autonomous_runs"("state");

-- CreateIndex
CREATE UNIQUE INDEX "autonomous_runs_render_session_id_key" ON "autonomous_runs"("render_session_id");

-- CreateIndex
CREATE INDEX "autonomous_runs_youtube_upload_id_idx" ON "autonomous_runs"("youtube_upload_id");

-- CreateIndex
CREATE INDEX "render_sessions_trigger_source_idx" ON "render_sessions"("trigger_source");

-- CreateIndex
CREATE INDEX "render_sessions_autonomous_run_id_idx" ON "render_sessions"("autonomous_run_id");

-- AddForeignKey
ALTER TABLE "autonomous_pipelines" ADD CONSTRAINT "autonomous_pipelines_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autonomous_day_overrides" ADD CONSTRAINT "autonomous_day_overrides_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "autonomous_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autonomous_day_plans" ADD CONSTRAINT "autonomous_day_plans_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "autonomous_pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_day_plan_id_fkey" FOREIGN KEY ("day_plan_id") REFERENCES "autonomous_day_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_render_session_id_fkey" FOREIGN KEY ("render_session_id") REFERENCES "render_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_youtube_upload_id_fkey" FOREIGN KEY ("youtube_upload_id") REFERENCES "youtube_uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
