import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PUSH_SENDER, type PushSender } from '../firebase/push.js';
import {
  BusyDeliveryError,
  DynamoDbEventStore,
} from '../persistence/dynamodb-event.store.js';
import { NotificationState } from '../redis/notification-state.js';
import type { PostEvent } from './post-event.js';

@Injectable()
export class PostEventHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostEventHandler.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private draining: Promise<void> = Promise.resolve();
  constructor(
    private readonly store: DynamoDbEventStore,
    private readonly state: NotificationState,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    @Optional() private readonly config?: ConfigService,
  ) {}
  onModuleInit(): void {
    if (!this.config?.get<string>('redis.url')) return;
    this.timer = setInterval(() => {
      if (!this.stopped)
        void this.drain().catch(() =>
          this.logger.warn('Push delivery retry failed'),
        );
    }, 30_000);
    this.timer.unref();
    void this.drain().catch(() =>
      this.logger.warn('Push delivery recovery failed'),
    );
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining;
  }
  async handle(event: PostEvent): Promise<void> {
    // Redis lock/window는 정확성의 근거가 아니다. 영속 commit의 CAS가 처리권을 결정한다.
    const recipient = await this.store.apply(event);
    if (recipient) await this.state.invalidateUnread(recipient);
    await this.dispatch(event.aggregateId);
  }
  async dispatch(postId?: string): Promise<void> {
    let failure: unknown;
    for (const pending of await this.store.deliveries(postId)) {
      try {
        const delivery = await this.store.acquire(pending);
        if (!delivery) continue;
        if (
          this.store.allowed &&
          !(await this.store.allowed(
            delivery.message.userId,
            delivery.postId,
            delivery.message.data?.type ?? '',
          ))
        ) {
          await this.store.finish(delivery, 'CANCELED');
          continue;
        }
        let result;
        try {
          result = await this.push.send(delivery.message);
        } catch (error) {
          // 응답을 잃으면 성공 여부는 알 수 없다. notificationId를 유지하고 at-least-once로 재시도한다.
          await this.store.finish(delivery, 'PENDING');
          throw error;
        }
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
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  async drain(): Promise<void> {
    if (this.running) return this.draining;
    this.running = true;
    this.draining = this.dispatch()
      .catch((error) => {
        if (!(error instanceof BusyDeliveryError))
          this.logger.warn('Push retry remains pending');
      })
      .finally(() => {
        this.running = false;
      });
    return this.draining;
  }
}
