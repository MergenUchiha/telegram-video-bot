import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../modules/storage/storage.service';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

@Injectable()
export class CleanupService implements OnModuleInit {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit() {
    this.cleanupStaleTmpDirs().catch((e) =>
      this.logger.warn(`tmp cleanup failed: ${e?.message}`),
    );
    this.ensureS3Lifecycle().catch((e) =>
      this.logger.warn(`S3 lifecycle setup failed: ${e?.message}`),
    );
  }

  private async cleanupStaleTmpDirs(): Promise<void> {
    const tmpRoot =
      this.config.get<string>('RENDER_TMP_DIR') ||
      path.join(os.tmpdir(), 'renderer');

    const maxAgeMs =
      Number(this.config.get<string>('TMP_CLEANUP_AGE_HOURS', '2')) *
      60 *
      60 *
      1000;

    if (!fs.existsSync(tmpRoot)) return;

    const entries = await fs.promises.readdir(tmpRoot, { withFileTypes: true });
    let removed = 0;
    let errors = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(tmpRoot, entry.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (Date.now() - stat.mtimeMs > maxAgeMs) {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        errors++;
      }
    }

    if (removed > 0 || errors > 0) {
      this.logger.log(
        `Tmp cleanup: removed ${removed} stale dirs` +
          (errors > 0 ? `, ${errors} errors` : ''),
      );
    }
  }

  private async ensureS3Lifecycle(): Promise<void> {
    const inputDays = Number(
      this.config.get<string>('INPUT_LIFECYCLE_DAYS', '3'),
    );
    const outputDays = Number(
      this.config.get<string>('OUTPUT_LIFECYCLE_DAYS', '7'),
    );

    try {
      await this.storage.putBucketLifecycle([
        { id: 'expire-inputs', prefix: 'inputs/', expirationDays: inputDays },
        {
          id: 'expire-outputs',
          prefix: 'outputs/',
          expirationDays: outputDays,
        },
      ]);
      this.logger.log(
        `S3 lifecycle set: inputs→${inputDays}d, outputs→${outputDays}d`,
      );
    } catch (e: any) {
      this.logger.warn(`S3 lifecycle setup skipped: ${e?.message}`);
    }
  }
}
