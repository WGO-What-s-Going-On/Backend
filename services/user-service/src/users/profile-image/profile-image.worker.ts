import { Injectable, Logger } from '@nestjs/common';
import { ProfileImageService } from './profile-image.service.js';

@Injectable()
export class ProfileImageCleanupWorker {
  private readonly logger = new Logger(ProfileImageCleanupWorker.name);
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
      .catch(() => {
        this.logger.warn('Profile image cleanup failed; retained for retry');
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
