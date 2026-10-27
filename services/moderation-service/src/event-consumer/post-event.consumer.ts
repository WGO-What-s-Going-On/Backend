import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

import { parsePostEvent } from './post-event.js';
import {
  POST_EVENT_PROCESSOR,
  type PostEventProcessor,
} from './post-event.processor.js';

export const POST_REDIS_CLIENT = Symbol('POST_REDIS_CLIENT');
type Entry = { id: string; message: Record<string, string> };

@Injectable()
export class PostEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostEventConsumer.name);
  private readonly consumer = `moderation-${randomUUID()}`;
  private readonly stream: string;
  private readonly group: string;
  private readonly deadStream = 'moderation:post:dead';
  private readonly redis: ReturnType<typeof createClient>;
  private stopped: boolean;
  private running?: Promise<void>;
  private pendingCursor = '0-0';

  constructor(
    config: ConfigService,
    @Inject(POST_EVENT_PROCESSOR)
    private readonly processor: PostEventProcessor,
    @Optional()
    @Inject(POST_REDIS_CLIENT)
    redis?: ReturnType<typeof createClient>,
  ) {
    const url = config.get<string>('redis.url');
    this.stream = config.get<string>('redis.postEventStream') ?? 'post:events';
    this.group =
      config.get<string>('redis.moderationConsumerGroup') ?? 'post-moderation';
    this.redis =
      redis ??
      createClient({
        url: url ?? 'redis://localhost:6383',
        disableOfflineQueue: true,
        commandOptions: { timeout: 3000 },
        socket: { connectTimeout: 2000 },
      });
    this.redis.on('error', () =>
      this.logger.warn(
        JSON.stringify({
          event: 'moderation_redis_error',
          service: 'moderation-service',
        }),
      ),
    );
    this.stopped = !url && !redis;
  }

  async onModuleInit(): Promise<void> {
    if (this.stopped) return;
    if (!this.redis.isOpen) await this.redis.connect();
    try {
      await this.redis.xGroupCreate(this.stream, this.group, '0', {
        MKSTREAM: true,
      });
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
    this.running = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    // 진행 중인 API 결과 저장과 ACK를 마친 뒤 연결을 닫는다. BLOCK은 최대 1초다.
    await this.running?.catch(() => undefined);
    if (this.redis.isOpen) await this.redis.quit();
  }

  async ready(): Promise<boolean> {
    return (
      !this.stopped &&
      this.redis.isReady &&
      (await this.redis.ping()) === 'PONG'
    );
  }

  async process(entry: Entry): Promise<void> {
    try {
      const event = parsePostEvent(entry.message);
      if (event) {
        const owner = randomUUID();
        const claim = await this.claim(event.eventId, owner);
        // 처리 중인 원본이 실패할 수 있으므로 완료 전 중복은 pending으로 남긴다.
        if (claim === 'busy') return;
        if (claim === 'acquired') {
          let renewal = Promise.resolve();
          const heartbeat = setInterval(() => {
            renewal = renewal
              .then(async () => {
                await this.redis.eval(
                  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],30) end return 0",
                  {
                    keys: [`moderation:dedup:${event.eventId}`],
                    arguments: [owner],
                  },
                );
              })
              .catch(() => undefined);
          }, 10_000);
          heartbeat.unref();
          try {
            await this.processor.process(event);
            if (!(await this.complete(event.eventId, owner))) return;
          } catch (error) {
            if (!(await this.release(event.eventId, owner))) return;
            throw error;
          } finally {
            clearInterval(heartbeat);
            await renewal;
          }
        }
      }
      try {
        await this.redis.xAck(this.stream, this.group, entry.id);
      } catch {
        // A committed result remains success even when transport ACK fails.
        this.logger.warn(
          JSON.stringify({
            event: 'moderation_ack_failed',
            service: 'moderation-service',
            streamId: entry.id,
            eventId: entry.message.eventId,
          }),
        );
      }
    } catch (error) {
      const pending = await this.redis.xPendingRange(
        this.stream,
        this.group,
        entry.id,
        entry.id,
        1,
      );
      const attempts = pending[0]?.deliveriesCounter ?? 1;
      this.logger.warn(
        JSON.stringify({
          event: 'moderation_event_retry',
          service: 'moderation-service',
          streamId: entry.id,
          eventId: entry.message.eventId,
          attempts,
        }),
      );
      if (
        (error instanceof Error && error.message.startsWith('Invalid')) ||
        attempts >= 5
      ) {
        await this.redis.xAdd(this.deadStream, '*', {
          streamId: entry.id,
          eventId: entry.message.eventId ?? '',
          error: String(error),
          data: entry.message.data ?? '',
        });
        await this.redis.xAck(this.stream, this.group, entry.id);
        this.logger.warn(
          JSON.stringify({
            event: 'moderation_event_dead_lettered',
            service: 'moderation-service',
            streamId: entry.id,
            eventId: entry.message.eventId,
            attempts,
          }),
        );
      }
    }
  }

  private async claim(
    eventId: string,
    owner: string,
  ): Promise<'done' | 'acquired' | 'busy'> {
    const key = `moderation:dedup:${eventId}`;
    if ((await this.redis.get(key)) === 'done') return 'done';
    return (await this.redis.set(key, owner, { NX: true, EX: 30 })) === 'OK'
      ? 'acquired'
      : 'busy';
  }

  private async complete(eventId: string, owner: string): Promise<boolean> {
    // TTL 만료 뒤 획득한 새 worker의 처리권과 완료 표시는 이전 worker가 변경할 수 없다.
    return (
      Number(
        await this.redis.eval(
          "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end redis.call('SET',KEYS[1],'done','EX',604800); return 1",
          {
            keys: [`moderation:dedup:${eventId}`],
            arguments: [owner],
          },
        ),
      ) === 1
    );
  }

  private async release(eventId: string, owner: string): Promise<boolean> {
    return (
      Number(
        await this.redis.eval(
          "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end return redis.call('DEL',KEYS[1])",
          {
            keys: [`moderation:dedup:${eventId}`],
            arguments: [owner],
          },
        ),
      ) === 1
    );
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.stopped) {
          this.logger.warn(
            JSON.stringify({
              event: 'moderation_consumer_poll_failed',
              service: 'moderation-service',
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  }

  async pollOnce(): Promise<void> {
    const claimed = (await this.redis.xAutoClaim(
      this.stream,
      this.group,
      this.consumer,
      30_000,
      this.pendingCursor,
      { COUNT: 20 },
    )) as unknown as { messages: Entry[]; nextId?: string };
    this.pendingCursor = claimed.nextId ?? '0-0';
    for (const entry of claimed.messages) {
      if (this.stopped) return;
      if (entry) await this.process(entry);
    }
    if (this.stopped) return;
    const batches = (await this.redis.xReadGroup(
      this.group,
      this.consumer,
      { key: this.stream, id: '>' },
      { COUNT: 20, BLOCK: 1000 },
    )) as unknown as Array<{ messages: Entry[] }> | null;
    for (const batch of batches ?? [])
      for (const entry of batch.messages) {
        if (this.stopped) return;
        await this.process(entry);
      }
  }
}
