import { createLogger } from '../../observability/logging.js';
import { Injectable } from '@nestjs/common';
import { ProfileImageService } from './profile-image.service.js';

@Injectable()
export class ProfileImageCleanupWorker {
  private readonly logger = createLogger('user-service', 'profile-image');
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(private readonly images: ProfileImageService) {}
  onModuleInit() {
    if (!this.images.storage.config.enabled) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, 60000);
    this.timer.unref();
  }
  async runOnce() {
    if (this.stopped) return;
    if (this.running) return this.running;
    this.running = this.images
      .cleanup()
      .catch((error) => {
        this.logger.failure(
          'profile_cleanup_failed',
          error,
          'PROFILE_CLEANUP_FAILED',
          'Profile image cleanup failed; retained for retry',
          {},
          true,
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
