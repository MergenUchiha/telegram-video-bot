/*
  Warnings:

  - You are about to drop the `used_jokes` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "render_sessions" ALTER COLUMN "text_card_preset" SET DEFAULT 'default';

-- DropTable
DROP TABLE "used_jokes";

-- CreateIndex
CREATE INDEX "render_sessions_content_mode_idx" ON "render_sessions"("content_mode");
