import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AutonomyService } from '../modules/autonomy/autonomy.service';
import { QueuesService } from '../modules/queues/queues.service';

@Injectable()
export class AutonomySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(AutonomySchedulerService.name);

  constructor(
    private readonly autonomy: AutonomyService,
    private readonly queues: QueuesService,
  ) {}

  async onModuleInit() {
    try {
      const { pipeline } = await this.autonomy.ensureBootstrapState();
      if (!this.autonomy.runtimeEnabledFlag()) {
        this.logger.log('Autonomy runtime kill-switch is disabled');
        return;
      }

      await this.queues.ensureAutonomyRepeatableJobs(
        pipeline.key,
        pipeline.timezone,
      );

      if (pipeline.enabled) {
        await this.queues.enqueueAutonomyReconcile(pipeline.key);
      }

      this.logger.log(
        `Autonomy scheduler armed for ${pipeline.key} (${pipeline.timezone})`,
      );
    } catch (error: any) {
      this.logger.error(`Autonomy scheduler init failed: ${error?.message}`);
    }
  }
}
