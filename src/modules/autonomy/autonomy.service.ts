import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ContentMode,
  YoutubeUploadStatus,
  YoutubeVisibility,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { QueuesService } from '../queues/queues.service';
import {
  AUTONOMY_DEFAULT_DAILY_COUNT,
  AUTONOMY_DEFAULT_MAX_DAILY_COUNT,
  AUTONOMY_DEFAULT_TIMEZONE,
  AUTONOMY_DEFAULT_WINDOW_END,
  AUTONOMY_DEFAULT_WINDOW_START,
  AUTONOMY_FALLBACK_CHAT_ID,
  AUTONOMY_PIPELINE_KEY,
  AUTONOMY_SYSTEM_TELEGRAM_USER_ID,
} from './autonomy.constants';
import {
  clipError,
  computeEvenlySpacedMinutes,
  formatMinutesAsClock,
  getDateStringInTimeZone,
  isValidDateOnly,
  parseClockToMinutes,
  shortYoutubeUrl,
  toDateOnly,
  zonedDateTimeToUtc,
} from './autonomy.utils';

export type AutonomousPipelineRecord = {
  id: string;
  key: string;
  enabled: boolean;
  ownerUserId: string;
  opsTelegramChatId: string;
  timezone: string;
  windowStartMinutes: number;
  windowEndMinutes: number;
  defaultDailyCount: number;
  maxDailyCount: number;
  contentMode: ContentMode;
  youtubeVisibility: YoutubeVisibility;
  titleSuffix: string;
  descriptionFooter: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AutonomousDayOverrideRecord = {
  id: string;
  pipelineId: string;
  planDate: Date;
  targetCount: number;
  createdByTelegramUserId: string;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AutonomousDayPlanRecord = {
  id: string;
  pipelineId: string;
  planDate: Date;
  targetCount: number;
  source: 'DEFAULT' | 'OVERRIDE';
  status: 'PLANNED' | 'IN_PROGRESS' | 'DONE' | 'PARTIAL_FAILED' | 'FAILED';
  createdAt: Date;
  updatedAt: Date;
};

export type AutonomousRunRecord = {
  id: string;
  dayPlanId: string;
  slotIndex: number;
  scheduledAt: Date;
  state:
    | 'PLANNED'
    | 'QUEUED'
    | 'RENDERING'
    | 'YOUTUBE_UPLOADING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'CANCELLED';
  renderSessionId: string | null;
  youtubeUploadId: string | null;
  youtubeVideoId: string | null;
  attemptCount: number;
  lastError: string | null;
  jokeTextSnapshot: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DayPlanSource = 'DEFAULT' | 'OVERRIDE';
type DayPlanStatus =
  | 'PLANNED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'PARTIAL_FAILED'
  | 'FAILED';
type RunState =
  | 'PLANNED'
  | 'QUEUED'
  | 'RENDERING'
  | 'YOUTUBE_UPLOADING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

@Injectable()
export class AutonomyService {
  private readonly logger = new Logger(AutonomyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly queues: QueuesService,
  ) {}

  pipelineKey(): string {
    return AUTONOMY_PIPELINE_KEY;
  }

  opsChatId(): string {
    return (
      this.config.get<string>('AUTONOMY_OPS_CHAT_ID') ||
      AUTONOMY_FALLBACK_CHAT_ID
    );
  }

  runtimeEnabledFlag(): boolean {
    return this.config.get<string>('AUTONOMY_ENABLED', 'false') === 'true';
  }

  defaultTimezone(): string {
    return (
      this.config.get<string>('AUTONOMY_TIMEZONE') || AUTONOMY_DEFAULT_TIMEZONE
    );
  }

  isRuntimeEnabled(pipeline: AutonomousPipelineRecord | null): boolean {
    return Boolean(
      pipeline &&
      pipeline.enabled &&
      this.runtimeEnabledFlag() &&
      this.opsChatId() &&
      this.opsChatId() !== AUTONOMY_FALLBACK_CHAT_ID,
    );
  }

  async ensureBootstrapState(): Promise<{
    owner: { id: string; telegramChatId: string; telegramUserId: string };
    pipeline: AutonomousPipelineRecord;
  }> {
    const owner = await this.ensureSystemOwner();
    const pipeline = await this.ensureDefaultPipeline(owner.id);
    return {
      owner: {
        id: owner.id,
        telegramChatId: owner.telegramChatId,
        telegramUserId: owner.telegramUserId,
      },
      pipeline,
    };
  }

  async ensureSystemOwner() {
    return this.sessions.getOrCreateUser(
      AUTONOMY_SYSTEM_TELEGRAM_USER_ID,
      this.opsChatId(),
    );
  }

  async ensureDefaultPipeline(
    ownerUserId?: string,
  ): Promise<AutonomousPipelineRecord> {
    const ownerId = ownerUserId ?? (await this.ensureSystemOwner()).id;
    const existing = await this.getPipelineByKey(this.pipelineKey());

    const timezone = this.defaultTimezone();
    const windowStartMinutes = parseClockToMinutes(
      this.config.get<string>(
        'AUTONOMY_WINDOW_START',
        AUTONOMY_DEFAULT_WINDOW_START,
      ),
      9 * 60,
    );
    const windowEndMinutes = parseClockToMinutes(
      this.config.get<string>(
        'AUTONOMY_WINDOW_END',
        AUTONOMY_DEFAULT_WINDOW_END,
      ),
      21 * 60,
    );
    const safeWindowEndMinutes =
      windowEndMinutes > windowStartMinutes ? windowEndMinutes : 21 * 60;
    const defaultDailyCountRaw = Number(
      this.config.get<string>(
        'AUTONOMY_DEFAULT_DAILY_COUNT',
        String(AUTONOMY_DEFAULT_DAILY_COUNT),
      ),
    );
    const maxDailyCountRaw = Number(
      this.config.get<string>(
        'AUTONOMY_MAX_DAILY_COUNT',
        String(AUTONOMY_DEFAULT_MAX_DAILY_COUNT),
      ),
    );
    const maxDailyCount =
      Number.isFinite(maxDailyCountRaw) && maxDailyCountRaw >= 1
        ? Math.round(maxDailyCountRaw)
        : AUTONOMY_DEFAULT_MAX_DAILY_COUNT;
    const defaultDailyCount =
      Number.isFinite(defaultDailyCountRaw) && defaultDailyCountRaw >= 1
        ? Math.min(Math.round(defaultDailyCountRaw), maxDailyCount)
        : Math.min(AUTONOMY_DEFAULT_DAILY_COUNT, maxDailyCount);
    const titleSuffix =
      this.config.get<string>('YOUTUBE_TITLE_SUFFIX', '#shorts') || '#shorts';
    const descriptionFooter =
      this.config.get<string>('YOUTUBE_DESCRIPTION_FOOTER') || null;

    if (!existing) {
      const inserted = await this.prisma.$queryRaw<AutonomousPipelineRecord[]>`
        INSERT INTO "autonomous_pipelines" (
          "id",
          "key",
          "enabled",
          "owner_user_id",
          "ops_telegram_chat_id",
          "timezone",
          "window_start_minutes",
          "window_end_minutes",
          "default_daily_count",
          "max_daily_count",
          "content_mode",
          "youtube_visibility",
          "title_suffix",
          "description_footer",
          "created_at",
          "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${this.pipelineKey()},
          ${this.runtimeEnabledFlag()},
          ${ownerId}::uuid,
          ${this.opsChatId()},
          ${timezone},
          ${windowStartMinutes},
          ${safeWindowEndMinutes},
          ${defaultDailyCount},
          ${maxDailyCount},
          ${'SPANISH_JOKES_AUTO'}::"ContentMode",
          ${'PUBLIC'}::"YoutubeVisibility",
          ${titleSuffix},
          ${descriptionFooter},
          NOW(),
          NOW()
        )
        RETURNING
          "id",
          "key",
          "enabled",
          "owner_user_id" AS "ownerUserId",
          "ops_telegram_chat_id" AS "opsTelegramChatId",
          "timezone",
          "window_start_minutes" AS "windowStartMinutes",
          "window_end_minutes" AS "windowEndMinutes",
          "default_daily_count" AS "defaultDailyCount",
          "max_daily_count" AS "maxDailyCount",
          "content_mode" AS "contentMode",
          "youtube_visibility" AS "youtubeVisibility",
          "title_suffix" AS "titleSuffix",
          "description_footer" AS "descriptionFooter",
          "created_at" AS "createdAt",
          "updated_at" AS "updatedAt"
      `;
      return inserted[0];
    }

    await this.prisma.$executeRaw`
      UPDATE "autonomous_pipelines"
      SET
        "owner_user_id" = ${ownerId}::uuid,
        "ops_telegram_chat_id" = ${this.opsChatId()},
        "timezone" = ${timezone},
        "window_start_minutes" = ${windowStartMinutes},
        "window_end_minutes" = ${safeWindowEndMinutes},
        "default_daily_count" = ${defaultDailyCount},
        "max_daily_count" = ${maxDailyCount},
        "content_mode" = ${'SPANISH_JOKES_AUTO'}::"ContentMode",
        "youtube_visibility" = ${'PUBLIC'}::"YoutubeVisibility",
        "title_suffix" = ${titleSuffix},
        "description_footer" = ${descriptionFooter},
        "updated_at" = NOW()
      WHERE "id" = ${existing.id}::uuid
    `;

    return (await this.getPipelineByKey(this.pipelineKey()))!;
  }

  async getPipelineByKey(
    key = this.pipelineKey(),
  ): Promise<AutonomousPipelineRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousPipelineRecord[]>`
      SELECT
        "id",
        "key",
        "enabled",
        "owner_user_id" AS "ownerUserId",
        "ops_telegram_chat_id" AS "opsTelegramChatId",
        "timezone",
        "window_start_minutes" AS "windowStartMinutes",
        "window_end_minutes" AS "windowEndMinutes",
        "default_daily_count" AS "defaultDailyCount",
        "max_daily_count" AS "maxDailyCount",
        "content_mode" AS "contentMode",
        "youtube_visibility" AS "youtubeVisibility",
        "title_suffix" AS "titleSuffix",
        "description_footer" AS "descriptionFooter",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_pipelines"
      WHERE "key" = ${key}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async setPipelineEnabled(enabled: boolean) {
    const pipeline =
      (await this.getPipelineByKey(this.pipelineKey())) ??
      (await this.ensureDefaultPipeline());
    await this.prisma.$executeRaw`
      UPDATE "autonomous_pipelines"
      SET "enabled" = ${enabled}, "updated_at" = NOW()
      WHERE "id" = ${pipeline.id}::uuid
    `;

    return this.getPipelineByKey(pipeline.key);
  }

  async getTodayStatus() {
    const pipeline =
      (await this.getPipelineByKey(this.pipelineKey())) ??
      (await this.ensureDefaultPipeline());
    const today = getDateStringInTimeZone(new Date(), pipeline.timezone);
    const plan = await this.getDayPlan(pipeline.id, today);
    const runs = plan ? await this.listRunsByDayPlan(plan.id) : [];
    const completed = runs.filter((run) => run.state === 'SUCCEEDED').length;
    const failed = runs.filter((run) => run.state === 'FAILED').length;
    const nextRun = await this.getNextScheduledRun(pipeline.id);
    const latestRun = await this.getLatestUploadedRun(pipeline.id);

    return {
      pipeline,
      today,
      plan,
      targetCount: plan?.targetCount ?? 0,
      completed,
      failed,
      nextRun,
      latestRun,
    };
  }

  async getMetricsSummary() {
    const { pipeline, targetCount, completed, failed, nextRun } =
      await this.getTodayStatus();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stats = await this.prisma.$queryRaw<
      Array<{ succeeded: bigint; failed: bigint }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE "state" = 'SUCCEEDED')::bigint AS "succeeded",
        COUNT(*) FILTER (WHERE "state" = 'FAILED')::bigint AS "failed"
      FROM "autonomous_runs"
      WHERE "scheduled_at" >= ${since}
    `;

    const succeeded = Number(stats[0]?.succeeded ?? 0);
    const failedTotal = Number(stats[0]?.failed ?? 0);
    const total = succeeded + failedTotal;

    return {
      enabled: this.isRuntimeEnabled(pipeline),
      configured: pipeline.enabled,
      todayTarget: targetCount,
      todayCompleted: completed,
      todayFailed: failed,
      nextScheduledAt: nextRun?.scheduledAt?.toISOString() ?? null,
      uploadSuccessRate:
        total > 0 ? `${Math.round((succeeded / total) * 1000) / 10}%` : '0%',
    };
  }

  async applyDayOverride(
    planDate: string,
    targetCount: number,
    createdByTelegramUserId: string,
    reason?: string,
  ) {
    if (!isValidDateOnly(planDate)) {
      throw new Error('planDate must be a valid YYYY-MM-DD date');
    }
    if (!Number.isInteger(targetCount)) {
      throw new Error('targetCount must be an integer');
    }

    const pipeline = await this.ensureDefaultPipeline();
    if (targetCount < 1 || targetCount > pipeline.maxDailyCount) {
      throw new Error(
        `targetCount must be between 1 and ${pipeline.maxDailyCount}`,
      );
    }

    const today = getDateStringInTimeZone(new Date(), pipeline.timezone);
    if (planDate === today) {
      const plan = await this.getDayPlan(pipeline.id, planDate);
      if (plan) {
        const runs = await this.listRunsByDayPlan(plan.id);
        const locked = runs.some((run) => run.state !== 'PLANNED');
        if (locked) {
          throw new Error(
            'Today is already locked because publishing has begun',
          );
        }
      }
    }

    const dateOnly = toDateOnly(planDate);
    const existing = await this.getDayOverride(pipeline.id, planDate);
    if (existing) {
      await this.prisma.$executeRaw`
        UPDATE "autonomous_day_overrides"
        SET
          "target_count" = ${targetCount},
          "created_by_telegram_user_id" = ${createdByTelegramUserId},
          "reason" = ${reason ?? null},
          "updated_at" = NOW()
        WHERE "id" = ${existing.id}::uuid
      `;
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO "autonomous_day_overrides" (
          "id",
          "pipeline_id",
          "plan_date",
          "target_count",
          "created_by_telegram_user_id",
          "reason",
          "created_at",
          "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${pipeline.id}::uuid,
          ${dateOnly},
          ${targetCount},
          ${createdByTelegramUserId},
          ${reason ?? null},
          NOW(),
          NOW()
        )
      `;
    }

    await this.buildDayPlan(pipeline.key, planDate);
    await this.queues.enqueueAutonomyReconcile(pipeline.key);
  }

  async buildDayPlan(
    pipelineKey: string,
    planDate: string,
  ): Promise<{
    pipeline: AutonomousPipelineRecord;
    plan: AutonomousDayPlanRecord;
    runs: AutonomousRunRecord[];
  }> {
    const pipeline =
      (await this.getPipelineByKey(pipelineKey)) ??
      (await this.ensureDefaultPipeline());
    const override = await this.getDayOverride(pipeline.id, planDate);
    const targetCount = override?.targetCount ?? pipeline.defaultDailyCount;
    const source: DayPlanSource = override ? 'OVERRIDE' : 'DEFAULT';

    let plan = await this.getDayPlan(pipeline.id, planDate);
    const existingRuns = plan ? await this.listRunsByDayPlan(plan.id) : [];
    const locked = existingRuns.some((run) => run.state !== 'PLANNED');

    if (plan && !locked) {
      await this.prisma.$executeRaw`
        UPDATE "autonomous_day_plans"
        SET
          "target_count" = ${targetCount},
          "source" = ${source}::"AutonomousDayPlanSource",
          "status" = ${'PLANNED'}::"AutonomousDayPlanStatus",
          "updated_at" = NOW()
        WHERE "id" = ${plan.id}::uuid
      `;
      await this.prisma.$executeRaw`
        DELETE FROM "autonomous_runs"
        WHERE "day_plan_id" = ${plan.id}::uuid
      `;
      plan = await this.getDayPlan(pipeline.id, planDate);
    }

    if (!plan) {
      const inserted = await this.prisma.$queryRaw<AutonomousDayPlanRecord[]>`
        INSERT INTO "autonomous_day_plans" (
          "id",
          "pipeline_id",
          "plan_date",
          "target_count",
          "source",
          "status",
          "created_at",
          "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${pipeline.id}::uuid,
          ${toDateOnly(planDate)},
          ${targetCount},
          ${source}::"AutonomousDayPlanSource",
          ${'PLANNED'}::"AutonomousDayPlanStatus",
          NOW(),
          NOW()
        )
        RETURNING
          "id",
          "pipeline_id" AS "pipelineId",
          "plan_date" AS "planDate",
          "target_count" AS "targetCount",
          "source",
          "status",
          "created_at" AS "createdAt",
          "updated_at" AS "updatedAt"
      `;
      plan = inserted[0];
    }

    if (locked) {
      return {
        pipeline,
        plan,
        runs: existingRuns,
      };
    }

    const slotMinutes = computeEvenlySpacedMinutes(
      targetCount,
      pipeline.windowStartMinutes,
      pipeline.windowEndMinutes,
    );
    const runs: AutonomousRunRecord[] = [];

    for (let index = 0; index < slotMinutes.length; index++) {
      const inserted = await this.prisma.$queryRaw<AutonomousRunRecord[]>`
        INSERT INTO "autonomous_runs" (
          "id",
          "day_plan_id",
          "slot_index",
          "scheduled_at",
          "state",
          "attempt_count",
          "created_at",
          "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${plan.id}::uuid,
          ${index},
          ${zonedDateTimeToUtc(planDate, slotMinutes[index], pipeline.timezone)},
          ${'PLANNED'}::"AutonomousRunState",
          0,
          NOW(),
          NOW()
        )
        RETURNING
          "id",
          "day_plan_id" AS "dayPlanId",
          "slot_index" AS "slotIndex",
          "scheduled_at" AS "scheduledAt",
          "state",
          "render_session_id" AS "renderSessionId",
          "youtube_upload_id" AS "youtubeUploadId",
          "youtube_video_id" AS "youtubeVideoId",
          "attempt_count" AS "attemptCount",
          "last_error" AS "lastError",
          "joke_text_snapshot" AS "jokeTextSnapshot",
          "created_at" AS "createdAt",
          "updated_at" AS "updatedAt"
      `;
      const run = inserted[0];
      runs.push(run);
      if (this.isRuntimeEnabled(pipeline)) {
        await this.queues.scheduleAutonomyRun(
          { runId: run.id },
          run.scheduledAt,
        );
      }
    }

    return { pipeline, plan, runs };
  }

  async reconcile(pipelineKey: string) {
    const pipeline =
      (await this.getPipelineByKey(pipelineKey)) ??
      (await this.ensureDefaultPipeline());
    if (!this.isRuntimeEnabled(pipeline)) {
      return;
    }

    const now = new Date();
    const today = getDateStringInTimeZone(now, pipeline.timezone);
    const tomorrow = getDateStringInTimeZone(
      new Date(now.getTime() + 24 * 60 * 60 * 1000),
      pipeline.timezone,
    );

    const planned = await Promise.all([
      this.buildDayPlan(pipeline.key, today),
      this.buildDayPlan(pipeline.key, tomorrow),
    ]);

    for (const item of planned) {
      await this.reschedulePlannedRuns(item.plan.id);
    }
  }

  async reschedulePlannedRuns(dayPlanId: string) {
    const plan = await this.getDayPlanById(dayPlanId);
    if (!plan) return;
    const pipeline = await this.getPipelineById(plan.pipelineId);
    if (!this.isRuntimeEnabled(pipeline)) return;

    const runs = await this.listRunsByDayPlan(dayPlanId);
    for (const run of runs) {
      if (run.state !== 'PLANNED') continue;
      await this.queues.scheduleAutonomyRun({ runId: run.id }, run.scheduledAt);
    }
  }

  async startRun(runId: string) {
    const run = await this.getRunById(runId);
    if (!run) {
      this.logger.warn(
        `Autonomy run ${runId} no longer exists; skipping stale job`,
      );
      return null;
    }
    if (
      run.state !== 'PLANNED' &&
      run.state !== 'FAILED' &&
      run.state !== 'CANCELLED'
    ) {
      return run;
    }

    const plan = await this.getDayPlanById(run.dayPlanId);
    if (!plan) {
      this.logger.warn(`Day plan missing for autonomy run ${runId}; skipping`);
      return null;
    }
    const pipeline = await this.getPipelineById(plan.pipelineId);
    if (!pipeline) {
      this.logger.warn(`Pipeline missing for autonomy run ${runId}; skipping`);
      return null;
    }
    if (!this.isRuntimeEnabled(pipeline)) {
      this.logger.warn(
        `Autonomy run ${runId} skipped because runtime is disabled`,
      );
      return run;
    }

    const owner = await this.ensureSystemOwner();
    const session = await this.sessions.createAutonomousSession(
      owner.id,
      run.id,
      pipeline.contentMode,
    );

    await this.prisma.$executeRaw`
      UPDATE "autonomous_runs"
      SET
        "state" = ${'QUEUED'}::"AutonomousRunState",
        "render_session_id" = ${session.id}::uuid,
        "youtube_upload_id" = NULL,
        "youtube_video_id" = NULL,
        "last_error" = NULL,
        "attempt_count" = "attempt_count" + 1,
        "updated_at" = NOW()
      WHERE "id" = ${runId}::uuid
    `;

    await this.updateDayPlanStatus(run.dayPlanId);
    await this.queues.enqueueRender({
      sessionId: session.id,
      userId: owner.id,
      chatId: pipeline.opsTelegramChatId,
    });

    return this.getRunById(runId);
  }

  async rerunFailedRun(runId: string) {
    const run = await this.getRunById(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.state !== 'FAILED') {
      throw new Error('Only failed runs can be re-queued');
    }

    await this.prisma.$executeRaw`
      UPDATE "autonomous_runs"
      SET
        "state" = ${'PLANNED'}::"AutonomousRunState",
        "last_error" = NULL,
        "youtube_upload_id" = NULL,
        "youtube_video_id" = NULL,
        "updated_at" = NOW()
      WHERE "id" = ${runId}::uuid
    `;
    await this.updateDayPlanStatus(run.dayPlanId);
    await this.queues.enqueueAutonomyRunNow({ runId });
    return this.getRunById(runId);
  }

  async markRunRenderingBySession(sessionId: string) {
    return this.updateRunStateBySession(sessionId, 'RENDERING');
  }

  async markRunYoutubeUploadingBySession(sessionId: string) {
    return this.updateRunStateBySession(sessionId, 'YOUTUBE_UPLOADING');
  }

  async markRunFailedBySession(sessionId: string, error: string) {
    const run = await this.getRunBySessionId(sessionId);
    if (!run) return null;
    await this.prisma.$executeRaw`
      UPDATE "autonomous_runs"
      SET
        "state" = ${'FAILED'}::"AutonomousRunState",
        "last_error" = ${clipError(error)},
        "updated_at" = NOW()
      WHERE "id" = ${run.id}::uuid
    `;
    await this.updateDayPlanStatus(run.dayPlanId);
    return this.getRunById(run.id);
  }

  async linkYoutubeUpload(runId: string, youtubeUploadId: string) {
    await this.prisma.$executeRaw`
      UPDATE "autonomous_runs"
      SET
        "youtube_upload_id" = ${youtubeUploadId}::uuid,
        "updated_at" = NOW()
      WHERE "id" = ${runId}::uuid
    `;
    return this.getRunById(runId);
  }

  async markRunSucceeded(
    runId: string,
    youtubeUploadId: string,
    youtubeVideoId: string,
  ) {
    const run = await this.getRunById(runId);
    if (!run) return null;

    await this.prisma.$executeRaw`
      UPDATE "autonomous_runs"
      SET
        "state" = ${'SUCCEEDED'}::"AutonomousRunState",
        "youtube_upload_id" = ${youtubeUploadId}::uuid,
        "youtube_video_id" = ${youtubeVideoId},
        "updated_at" = NOW()
      WHERE "id" = ${runId}::uuid
    `;
    await this.updateDayPlanStatus(run.dayPlanId);
    return this.getRunById(runId);
  }

  async setRunJokeSnapshot(runId: string, jokeText: string) {
    await this.prisma.$executeRaw`
      UPDATE "autonomous_runs"
      SET
        "joke_text_snapshot" = ${jokeText},
        "updated_at" = NOW()
      WHERE "id" = ${runId}::uuid
    `;
  }

  async getRunById(runId: string): Promise<AutonomousRunRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousRunRecord[]>`
      SELECT
        "id",
        "day_plan_id" AS "dayPlanId",
        "slot_index" AS "slotIndex",
        "scheduled_at" AS "scheduledAt",
        "state",
        "render_session_id" AS "renderSessionId",
        "youtube_upload_id" AS "youtubeUploadId",
        "youtube_video_id" AS "youtubeVideoId",
        "attempt_count" AS "attemptCount",
        "last_error" AS "lastError",
        "joke_text_snapshot" AS "jokeTextSnapshot",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_runs"
      WHERE "id" = ${runId}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getRunBySessionId(
    sessionId: string,
  ): Promise<AutonomousRunRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousRunRecord[]>`
      SELECT
        "id",
        "day_plan_id" AS "dayPlanId",
        "slot_index" AS "slotIndex",
        "scheduled_at" AS "scheduledAt",
        "state",
        "render_session_id" AS "renderSessionId",
        "youtube_upload_id" AS "youtubeUploadId",
        "youtube_video_id" AS "youtubeVideoId",
        "attempt_count" AS "attemptCount",
        "last_error" AS "lastError",
        "joke_text_snapshot" AS "jokeTextSnapshot",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_runs"
      WHERE "render_session_id" = ${sessionId}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getDayPlan(
    pipelineId: string,
    planDate: string,
  ): Promise<AutonomousDayPlanRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousDayPlanRecord[]>`
      SELECT
        "id",
        "pipeline_id" AS "pipelineId",
        "plan_date" AS "planDate",
        "target_count" AS "targetCount",
        "source",
        "status",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_day_plans"
      WHERE "pipeline_id" = ${pipelineId}::uuid
        AND "plan_date" = ${toDateOnly(planDate)}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getDayPlanById(
    planId: string,
  ): Promise<AutonomousDayPlanRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousDayPlanRecord[]>`
      SELECT
        "id",
        "pipeline_id" AS "pipelineId",
        "plan_date" AS "planDate",
        "target_count" AS "targetCount",
        "source",
        "status",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_day_plans"
      WHERE "id" = ${planId}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getPipelineById(
    pipelineId: string,
  ): Promise<AutonomousPipelineRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousPipelineRecord[]>`
      SELECT
        "id",
        "key",
        "enabled",
        "owner_user_id" AS "ownerUserId",
        "ops_telegram_chat_id" AS "opsTelegramChatId",
        "timezone",
        "window_start_minutes" AS "windowStartMinutes",
        "window_end_minutes" AS "windowEndMinutes",
        "default_daily_count" AS "defaultDailyCount",
        "max_daily_count" AS "maxDailyCount",
        "content_mode" AS "contentMode",
        "youtube_visibility" AS "youtubeVisibility",
        "title_suffix" AS "titleSuffix",
        "description_footer" AS "descriptionFooter",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_pipelines"
      WHERE "id" = ${pipelineId}::uuid
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getDayOverride(
    pipelineId: string,
    planDate: string,
  ): Promise<AutonomousDayOverrideRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousDayOverrideRecord[]>`
      SELECT
        "id",
        "pipeline_id" AS "pipelineId",
        "plan_date" AS "planDate",
        "target_count" AS "targetCount",
        "created_by_telegram_user_id" AS "createdByTelegramUserId",
        "reason",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_day_overrides"
      WHERE "pipeline_id" = ${pipelineId}::uuid
        AND "plan_date" = ${toDateOnly(planDate)}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async listRunsByDayPlan(dayPlanId: string): Promise<AutonomousRunRecord[]> {
    return this.prisma.$queryRaw<AutonomousRunRecord[]>`
      SELECT
        "id",
        "day_plan_id" AS "dayPlanId",
        "slot_index" AS "slotIndex",
        "scheduled_at" AS "scheduledAt",
        "state",
        "render_session_id" AS "renderSessionId",
        "youtube_upload_id" AS "youtubeUploadId",
        "youtube_video_id" AS "youtubeVideoId",
        "attempt_count" AS "attemptCount",
        "last_error" AS "lastError",
        "joke_text_snapshot" AS "jokeTextSnapshot",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "autonomous_runs"
      WHERE "day_plan_id" = ${dayPlanId}::uuid
      ORDER BY "slot_index" ASC
    `;
  }

  async getNextScheduledRun(
    pipelineId: string,
  ): Promise<AutonomousRunRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousRunRecord[]>`
      SELECT
        runs."id",
        runs."day_plan_id" AS "dayPlanId",
        runs."slot_index" AS "slotIndex",
        runs."scheduled_at" AS "scheduledAt",
        runs."state",
        runs."render_session_id" AS "renderSessionId",
        runs."youtube_upload_id" AS "youtubeUploadId",
        runs."youtube_video_id" AS "youtubeVideoId",
        runs."attempt_count" AS "attemptCount",
        runs."last_error" AS "lastError",
        runs."joke_text_snapshot" AS "jokeTextSnapshot",
        runs."created_at" AS "createdAt",
        runs."updated_at" AS "updatedAt"
      FROM "autonomous_runs" runs
      INNER JOIN "autonomous_day_plans" plans ON plans."id" = runs."day_plan_id"
      WHERE plans."pipeline_id" = ${pipelineId}::uuid
        AND (
          (runs."state" IN ('PLANNED', 'QUEUED') AND runs."scheduled_at" >= NOW())
          OR runs."state" IN ('RENDERING', 'YOUTUBE_UPLOADING')
        )
      ORDER BY runs."scheduled_at" ASC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getLatestUploadedRun(
    pipelineId: string,
  ): Promise<AutonomousRunRecord | null> {
    const rows = await this.prisma.$queryRaw<AutonomousRunRecord[]>`
      SELECT
        runs."id",
        runs."day_plan_id" AS "dayPlanId",
        runs."slot_index" AS "slotIndex",
        runs."scheduled_at" AS "scheduledAt",
        runs."state",
        runs."render_session_id" AS "renderSessionId",
        runs."youtube_upload_id" AS "youtubeUploadId",
        runs."youtube_video_id" AS "youtubeVideoId",
        runs."attempt_count" AS "attemptCount",
        runs."last_error" AS "lastError",
        runs."joke_text_snapshot" AS "jokeTextSnapshot",
        runs."created_at" AS "createdAt",
        runs."updated_at" AS "updatedAt"
      FROM "autonomous_runs" runs
      INNER JOIN "autonomous_day_plans" plans ON plans."id" = runs."day_plan_id"
      WHERE plans."pipeline_id" = ${pipelineId}::uuid
        AND runs."youtube_video_id" IS NOT NULL
      ORDER BY runs."updated_at" DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getOrCreateYoutubeUploadRecord(
    sessionId: string,
    runId: string,
    channelId: string,
  ) {
    const run = await this.getRunById(runId);
    if (run?.youtubeUploadId) {
      return this.prisma.youtubeUpload.update({
        where: { id: run.youtubeUploadId },
        data: {
          status: YoutubeUploadStatus.UPLOADING,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
        },
      });
    }

    const created = await this.prisma.youtubeUpload.create({
      data: {
        sessionId,
        channelId,
        status: YoutubeUploadStatus.UPLOADING,
        startedAt: new Date(),
      },
    });
    await this.linkYoutubeUpload(runId, created.id);
    return created;
  }

  async markYoutubeUploadFailed(
    runId: string,
    youtubeUploadId: string,
    error: string,
  ) {
    await this.prisma.youtubeUpload.update({
      where: { id: youtubeUploadId },
      data: {
        status: YoutubeUploadStatus.FAILED,
        error: clipError(error, 900),
        finishedAt: new Date(),
      },
    });

    const run = await this.getRunById(runId);
    if (run) {
      await this.prisma.$executeRaw`
        UPDATE "autonomous_runs"
        SET
          "state" = ${'FAILED'}::"AutonomousRunState",
          "last_error" = ${clipError(error)},
          "updated_at" = NOW()
        WHERE "id" = ${runId}::uuid
      `;
      await this.updateDayPlanStatus(run.dayPlanId);
    }
  }

  async markYoutubeUploadDone(
    runId: string,
    youtubeUploadId: string,
    youtubeVideoId: string,
  ) {
    await this.prisma.youtubeUpload.update({
      where: { id: youtubeUploadId },
      data: {
        status: YoutubeUploadStatus.DONE,
        youtubeVideoId,
        error: null,
        finishedAt: new Date(),
      },
    });
    await this.markRunSucceeded(runId, youtubeUploadId, youtubeVideoId);
  }

  buildStatusMessage(status: Awaited<ReturnType<typeof this.getTodayStatus>>) {
    const next = status.nextRun
      ? `${status.nextRun.scheduledAt.toISOString()} (${status.nextRun.state})`
      : 'none';
    const latest = status.latestRun?.youtubeVideoId
      ? shortYoutubeUrl(status.latestRun.youtubeVideoId)
      : 'none';

    return [
      'Autonomy status',
      '',
      `Enabled: ${status.pipeline.enabled ? 'yes' : 'no'} (env=${this.runtimeEnabledFlag() ? 'on' : 'off'})`,
      `Timezone: ${status.pipeline.timezone}`,
      `Window: ${formatMinutesAsClock(status.pipeline.windowStartMinutes)}-${formatMinutesAsClock(status.pipeline.windowEndMinutes)}`,
      `Today: ${status.today}`,
      `Target count: ${status.targetCount}`,
      `Completed: ${status.completed}`,
      `Failed: ${status.failed}`,
      `Next slot: ${next}`,
      `Latest upload: ${latest}`,
    ].join('\n');
  }

  private async updateRunStateBySession(sessionId: string, state: RunState) {
    const run = await this.getRunBySessionId(sessionId);
    if (!run) return null;
    await this.prisma.$executeRaw`
      UPDATE "autonomous_runs"
      SET
        "state" = ${state}::"AutonomousRunState",
        "updated_at" = NOW()
      WHERE "id" = ${run.id}::uuid
    `;
    await this.updateDayPlanStatus(run.dayPlanId);
    return this.getRunById(run.id);
  }

  private async updateDayPlanStatus(dayPlanId: string) {
    const runs = await this.listRunsByDayPlan(dayPlanId);
    let status: DayPlanStatus = 'PLANNED';

    if (runs.length === 0 || runs.every((run) => run.state === 'PLANNED')) {
      status = 'PLANNED';
    } else if (runs.every((run) => run.state === 'SUCCEEDED')) {
      status = 'DONE';
    } else {
      const failed = runs.filter((run) => run.state === 'FAILED').length;
      if (failed === runs.length) {
        status = 'FAILED';
      } else if (failed > 0) {
        status = 'PARTIAL_FAILED';
      } else {
        status = 'IN_PROGRESS';
      }
    }

    await this.prisma.$executeRaw`
      UPDATE "autonomous_day_plans"
      SET
        "status" = ${status}::"AutonomousDayPlanStatus",
        "updated_at" = NOW()
      WHERE "id" = ${dayPlanId}::uuid
    `;
  }
}
