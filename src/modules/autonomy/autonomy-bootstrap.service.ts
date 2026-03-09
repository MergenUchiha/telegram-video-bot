import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { YoutubeService } from '../youtube/youtube.service';
import { AutonomyService } from './autonomy.service';
import { clipError } from './autonomy.utils';

@Injectable()
export class AutonomyBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AutonomyBootstrapService.name);

  constructor(
    private readonly autonomy: AutonomyService,
    private readonly youtube: YoutubeService,
  ) {}

  async onModuleInit() {
    try {
      const { owner, pipeline } = await this.autonomy.ensureBootstrapState();
      await this.youtube.ensureSystemChannel(owner.id);
      this.logger.log(
        `Autonomy bootstrap ready for pipeline ${pipeline.key} (enabled=${pipeline.enabled})`,
      );
    } catch (error) {
      this.logger.error(`Autonomy bootstrap failed: ${clipError(error, 400)}`);
    }
  }
}
