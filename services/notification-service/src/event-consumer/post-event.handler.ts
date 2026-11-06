import { createLogger } from '../observability/logging.js';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PUSH_SENDER, type PushSender } from '../firebase/push.js';
import {
  BusyDeliveryError,
  PostgresEventStore,
} from '../persistence/postgres-event.store.js';
import { NotificationState } from '../redis/notification-state.js';
import type { PostEvent } from './post-event.js';
import { NotificationBlockChecker } from '../notification/block-checker.js';

@Injectable()
export class PostEventHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('notification-service', 'push');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private draining: Promise<void> = Promise.resolve();
  constructor(
    private readonly store: PostgresEventStore,
    private readonly state: NotificationState,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly blocks?: NotificationBlockChecker,
  ) {}
  onModuleInit(): void {
    if (!this.config?.get<string>('redis.url')) return;
    if (
      this.config.get<string>('NOTIFICATION_PUSH_DELIVERY_ENABLED') === 'false'
    ) {
      this.logger.emit({
        event: 'push_delivery_paused',
        outcome: 'skipped',
        reasonCode: 'PUSH_DELIVERY_PAUSED',
        message: 'Push delivery is paused; pending jobs are retained',
      });
      return;
    }
    this.timer = setInterval(() => {
      if (!this.stopped)
        void this.drain().catch((error) =>
          this.logger.failure(
            'push_recovery_failed',
            error,
            'PUSH_RECOVERY_FAILED',
            'Push delivery retry failed',
            {},
            true,
          ),
        );
    }, 30_000);
    this.timer.unref();
    void this.drain().catch((error) =>
      this.logger.failure(
        'push_recovery_failed',
        error,
        'PUSH_RECOVERY_FAILED',
        'Push delivery recovery failed',
        {},
        true,
      ),
    );
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining;
  }
  async handle(event: PostEvent): Promise<void> {
    // Redis lock/window는 정확성의 근거가 아니다. PostgreSQL transaction의 post 행 잠금이 처리권을 결정한다.
    const recipient = await this.store.apply(event);
    for (const id of new Set([
      recipient,
      event.commentAuthorId,
      event.parentCommentAuthorId,
    ]))
      if (id) await this.state.invalidateUnread(id);
    await this.dispatch(event.aggregateId);
  }
  async dispatch(postId?: string): Promise<void> {
    if (
      this.config?.get<string>('NOTIFICATION_PUSH_DELIVERY_ENABLED') === 'false'
    )
      return;
    let failure: unknown;
    for (const pending of await this.store.deliveries(postId)) {
      try {
        const delivery = await this.store.acquire(pending);
        if (!delivery) {
          this.logger.skipped('push_delivery_skipped', 'LEASE_UNAVAILABLE');
          continue;
        }
        if (
          this.store.allowed &&
          !(await this.store.allowed(
            delivery.message.userId,
            delivery.postId,
            delivery.message.data?.category ??
              delivery.message.data?.type ??
              '',
          ))
        ) {
          await this.store.finish(delivery, 'CANCELED');
          this.logger.skipped(
            'push_delivery_canceled',
            'DELIVERY_NOT_ALLOWED',
            {
              attempt: delivery.attempts,
              postId: delivery.postId,
            },
          );
          continue;
        }
        let result;
        try {
          const actorId =
            delivery.message.authorizationActorId ??
            delivery.message.data?.actorId;
          if (
            actorId &&
            this.blocks &&
            !(await this.blocks.allowed(delivery.message.userId, actorId))
          ) {
            await this.store.finish(delivery, 'CANCELED');
            this.logger.skipped(
              'push_delivery_canceled',
              'DELIVERY_NOT_ALLOWED',
              {
                attempt: delivery.attempts,
                postId: delivery.postId,
              },
            );
            continue;
          }
          result = await this.push.send(delivery.message);
        } catch (error) {
          // 응답을 잃으면 성공 여부는 알 수 없다. notificationId를 유지하고 at-least-once로 재시도한다.
          await this.store.finish(delivery, 'PENDING');
          throw error;
        }
        const counts = {
          attempt: delivery.attempts,
          postId: delivery.postId,
          count: result.attempted,
          delivered: result.succeeded,
          failed: result.failed,
        };
        if (result.succeeded > 0)
          this.logger.success(
            'push_delivery_sent',
            'FCM accepted push messages',
            counts,
          );
        const retry = result.retryTokens;
        if (
          retry?.length ||
          (retry === undefined &&
            result.failed >
              result.invalidTokens.length +
                (result.permanentTokens?.length ?? 0))
        ) {
          await this.store.finish(delivery, 'PENDING', retry);
          throw new Error('Transient push failure; durable retry scheduled');
        }
        await this.store.finish(
          delivery,
          result.failed > result.invalidTokens.length ? 'FAILED' : 'SENT',
        );
        if (result.failed > result.invalidTokens.length)
          this.logger.failure(
            'push_delivery_failed',
            undefined,
            'PUSH_PERMANENT_FAILURE',
            'Push delivery completed with permanent failures',
            counts,
            false,
          );
        else if (result.succeeded === 0)
          this.logger.emit({
            ...counts,
            event: 'push_delivery_skipped',
            outcome: 'skipped',
            reasonCode: result.attempted === 0 ? 'NO_TOKENS' : 'INVALID_TOKENS',
            message: 'No FCM message accepted for this delivery attempt',
          });
      } catch (error) {
        if (!(error instanceof BusyDeliveryError))
          this.logger.failure(
            'push_delivery_deferred',
            error,
            'PUSH_DELIVERY_FAILED',
            'Push delivery failed; durable state retained',
            {
              postId,
              attempt: pending.attempts,
            },
            true,
          );
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  async ignore(fields: Record<string, string>) {
    await this.store.recordIgnored(fields);
    this.logger.skipped('notification_event_ignored', 'UNSUPPORTED_EVENT', {
      eventId: fields.eventId,
    });
  }
  async drain(): Promise<void> {
    if (this.running) return this.draining;
    this.running = true;
    this.draining = this.dispatch()
      .catch((error) => {
        if (!(error instanceof BusyDeliveryError))
          this.logger.failure(
            'push_recovery_failed',
            error,
            'PUSH_RECOVERY_FAILED',
            'Push retry remains pending',
            {},
            true,
          );
      })
      .finally(() => {
        this.running = false;
      });
    return this.draining;
  }
}
