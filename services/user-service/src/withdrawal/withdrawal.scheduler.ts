import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OAuthAccountEntity } from '../database/entities/oauth-account.entity.js';
import { UserBadgeEntity } from '../database/entities/user-badge.entity.js';
import { UserBlockEntity } from '../database/entities/user-block.entity.js';
import { UserEntity, UserStatus } from '../database/entities/user.entity.js';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';

@Injectable()
export class WithdrawalScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalScheduler.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  constructor(@InjectDataSource() private readonly database: DataSource, config: ConfigService) {
    this.pollIntervalMs = config.getOrThrow<number>('withdrawal.pollIntervalMs');
    this.batchSize = config.getOrThrow<number>('withdrawal.batchSize');
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => { void this.finalizePending(); }, this.pollIntervalMs);
    this.timer.unref();
    void this.finalizePending();
  }

  finalizePending(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.finalizeBatch().catch(() => {
      this.logger.warn('Withdrawal finalization failed; retry on next poll');
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  private async finalizeBatch(): Promise<void> {
    await this.database.transaction(async (manager) => {
      const users = manager.getRepository(UserEntity);
      const candidates = await users.createQueryBuilder('user')
        .where('user.status = :status', { status: UserStatus.WITHDRAWAL_PENDING })
        .andWhere('user.withdrawalDeadlineAt <= :now', { now: new Date() })
        .orderBy('user.withdrawalDeadlineAt', 'ASC').addOrderBy('user.id', 'ASC')
        .take(this.batchSize).setLock('pessimistic_write').setOnLocked('skip_locked').getMany();
      for (const user of candidates) {
        if (this.stopping) break;
        const now = new Date();
        // Same row lock as Kakao restore. Never finalize a restored account or a future deadline.
        if (user.status !== UserStatus.WITHDRAWAL_PENDING || !user.withdrawalDeadlineAt ||
            user.withdrawalDeadlineAt.getTime() > now.getTime()) continue;
        user.status = UserStatus.WITHDRAWN;
        user.withdrawnAt = now;
        user.updatedAt = now;
        user.nickname = tombstoneNickname(user.id);
        user.profileImageKey = null;
        await users.save(user);
        // Unlink login identity and remove service-local relations without deleting the user tombstone.
        await manager.getRepository(OAuthAccountEntity).delete({ userId: user.id });
        await manager.getRepository(UserBlockEntity).createQueryBuilder().delete()
          .where('blocker_user_id = :userId OR blocked_user_id = :userId', { userId: user.id }).execute();
        await manager.getRepository(UserBadgeEntity).delete({ userId: user.id });
        const eventId = randomUUID();
        const eventType = 'USER_WITHDRAWN';
        await manager.getRepository(OutboxEventEntity).insert({
          eventId, aggregateId: user.id, eventType,
          payload: {
            eventId, type: eventType, producer: 'user-service', correlationId: randomUUID(),
            target: { type: 'USER', id: user.id }, occurredAt: now.toISOString(), version: 1,
            payload: { userId: user.id, withdrawnAt: now.toISOString() },
          },
          status: 'PENDING', publishAttempts: 0, createdAt: now, publishedAt: null,
        });
        // No Redis dependency: refresh already rejects non-ACTIVE users even with stale sessions.
      }
    });
  }
}

function tombstoneNickname(userId: string): string {
  const suffix = createHash('sha256').update(userId).digest('base64url').toLowerCase().slice(0, 20);
  return `withdrawn_${suffix}`;
}
