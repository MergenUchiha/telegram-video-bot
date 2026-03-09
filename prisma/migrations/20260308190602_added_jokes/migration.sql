-- CreateEnum
CREATE TYPE "ContentMode" AS ENUM ('STANDARD', 'SPANISH_JOKES_AUTO');

-- AlterTable
ALTER TABLE "render_sessions" ADD COLUMN     "auto_publish_youtube" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "background_music_key" TEXT,
ADD COLUMN     "background_video_key" TEXT,
ADD COLUMN     "content_mode" "ContentMode" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "joke_language" TEXT DEFAULT 'es',
ADD COLUMN     "joke_source_url" TEXT,
ADD COLUMN     "joke_text" TEXT,
ADD COLUMN     "text_card_preset" TEXT DEFAULT 'telegram';

-- CreateTable
CREATE TABLE "used_jokes" (
    "id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "used_jokes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "used_jokes_hash_key" ON "used_jokes"("hash");

-- CreateIndex
CREATE INDEX "used_jokes_source_url_idx" ON "used_jokes"("source_url");
