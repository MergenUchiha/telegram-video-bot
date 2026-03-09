import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AutonomyService } from '../modules/autonomy/autonomy.service';
import { AutonomyPlanDayPayload, AutonomyRunPayload } from '../modules/queues/queues.service';
import { QUEUE_AUTONOMY } from '../modules/redis/redis.constants';
import { getDateStringInTimeZone } from '../modules/autonomy/autonomy.utils';

@Processor(QUEUE_AUTONOMY, { concurrency: 1 })
export class AutonomyProcessor extends WorkerHost {
  private readonly logger = new Logger(AutonomyProcessor.name);

  constructor(private readonly autonomy: AutonomyService) {
    super();
  }

  async process(
    job: Job<AutonomyPlanDayPayload | AutonomyRunPayload>,
  ): Promise<void> {
    if (job.name === 'run-slot') {
      const payload = job.data as AutonomyRunPayload;
      await this.autonomy.startRun(payload.runId);
      return;
    }

    if (job.name === 'reconcile') {
      const payload = job.data as AutonomyPlanDayPayload;
      await this.autonomy.reconcile(payload.pipelineKey);
      return;
    }

    if (job.name === 'plan-day') {
      const payload = job.data as AutonomyPlanDayPayload;
      const pipeline =
        (await this.autonomy.getPipelineByKey(payload.pipelineKey)) ??
        (await this.autonomy.ensureDefaultPipeline());
      if (!this.autonomy.isRuntimeEnabled(pipeline)) {
        this.logger.debug(
          `Skipping plan-day for ${pipeline.key}: runtime disabled`,
        );
        return;
      }
      const planDate =
        payload.planDate === '__today__'
          ? getDateStringInTimeZone(new Date(), pipeline.timezone)
          : payload.planDate;

      await this.autonomy.buildDayPlan(payload.pipelineKey, planDate);
      return;
    }

    this.logger.warn(`Unhandled autonomy job: ${job.name}`);
  }
}
