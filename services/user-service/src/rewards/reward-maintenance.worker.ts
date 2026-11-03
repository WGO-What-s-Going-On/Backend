import { TitleService } from './title.service.js';
import {
  Injectable,
  Optional,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ActivityService } from './activity.service.js';
import { RewardEngine } from './reward-engine.js';

@Injectable()
export class RewardMaintenanceWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RewardMaintenanceWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;
  private before = '0';
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly activities: ActivityService,
    private readonly engine: RewardEngine,
    @Optional() private readonly titles: TitleService = new TitleService(),
  ) {}
  onApplicationBootstrap(): void {
    if (!this.engine.policy.enabled && !this.titles.settings.enabled) return;
    this.timer = setInterval(() => void this.run(), 1000);
    this.timer.unref();
  }
  run(): Promise<void> {
    if (
      this.stopping ||
      (!this.engine.policy.enabled && !this.titles.settings.enabled)
    )
      return Promise.resolve();
    this.running ??= this.batch()
      .catch(() => {
        this.logger.warn('Reward reconciliation failed; retry on next scan');
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async batch() {
    const users: Array<{ id: string; status: string }> = await this.db.query(
      `SELECT u.id,u.status FROM users u WHERE u.id>$1 AND (
        EXISTS(SELECT 1 FROM user_activities a WHERE a.actor_id=u.id OR a.beneficiary_id=u.id)
        OR EXISTS(SELECT 1 FROM user_title_progress p WHERE p.user_id=u.id)
        OR EXISTS(SELECT 1 FROM user_badges b WHERE b.user_id=u.id AND b.revoked_at IS NULL))
        ORDER BY u.id LIMIT 20`,
      [this.before],
    );
    this.before = users.at(-1)?.id ?? '0';
    for (const user of users) {
      if (this.stopping) break;
      const [held] = await this.db.query(
        "SELECT 1 FROM user_activities WHERE beneficiary_id=$1 AND eligibility='PENDING_ACCOUNT' LIMIT 1",
        [user.id],
      );
      if (user.status !== 'ACTIVE' || held)
        await this.activities.reconcileUser(user.id, randomUUID());
      await this.activities.refreshUserTitles(user.id);
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
