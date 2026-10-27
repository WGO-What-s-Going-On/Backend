import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { SubscriptionManager } from './subscription-manager.js';
import { WebSocket } from 'ws';
import {
  InvalidPostEvent,
  realtimePostEvent,
  type PostRealtimeMessage,
} from './post-event-contract.js';

const stream = 'post:events';
const group = 'post-realtime';
const channel = 'post:realtime';
const deadStream = 'post-realtime:dead';

// Redis에서 버전 판정·발행·상태 저장을 직렬화한다. 다른 Consumer의 역순 처리와 재시작도 보호한다.
// 이 상태는 원본이 아닌 소비자 재생 방어용이며 TTL로 삭제하면 오래된 생성 이벤트가 부활할 수 있다.
const publishOrdered = `
local m=cjson.decode(ARGV[1])
local terminal=redis.call('HGET',KEYS[1],'status')
local ending=m.type=='post.deleted' or m.type=='post.expired'
if terminal and not ending then return 0 end
if ending then
  if terminal=='post.deleted' or terminal==m.type then return 0 end
  local prior=tonumber(redis.call('HGET',KEYS[1],'postVersion') or '0')
  if prior>=tonumber(m.postVersion) then return 0 end
elseif m.type=='comment.created' or m.type=='comment.deleted' then
  local field='comment:'..m.comment.commentId
  local deleted=redis.call('HGET',KEYS[1],'deleted:'..m.comment.commentId)
  if deleted then return 0 end
  local prior=tonumber(redis.call('HGET',KEYS[1],field) or '0')
  if prior>=tonumber(m.activityVersion) then return 0 end
end
local delivered=redis.call('PUBLISH',ARGV[2],ARGV[1])
if delivered==0 then return -1 end
if ending then
  redis.call('DEL',KEYS[1])
  redis.call('HSET',KEYS[1],'status',m.type,'postVersion',tostring(m.postVersion))
elseif m.type=='comment.created' or m.type=='comment.deleted' then
  redis.call('HSET',KEYS[1],'comment:'..m.comment.commentId,tostring(m.activityVersion))
  if m.type=='comment.deleted' then redis.call('HSET',KEYS[1],'deleted:'..m.comment.commentId,'1') end
end
return delivered
`;

export interface RealtimeBus {
  start(): Promise<void>;
  close(): Promise<void>;
  ready(): boolean;
  metrics?(): Promise<{ consumerPending: number; deliveryFailures: number }>;
}

export class PostEvents implements RealtimeBus {
  private readonly reader;
  private readonly publisher;
  private readonly subscriber;
  private readonly consumer = randomUUID();
  private stopped = false;
  private active = false;
  private running?: Promise<void>;
  private cursor = '0-0';
  private readonly seen = new Map<string, number>();
  private failures = 0;

  constructor(
    redisUrl: string,
    private readonly subscriptions: SubscriptionManager,
    private readonly log: { warn(value: unknown): void },
  ) {
    const options = {
      url: redisUrl,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2000 },
    };
    this.reader = createClient(options);
    this.publisher = createClient(options);
    this.subscriber = createClient(options);
    for (const client of [this.reader, this.publisher, this.subscriber])
      client.on('error', () =>
        this.log.warn({ event: 'realtime_redis_error' }),
      );
    this.subscriber.on('error', () => this.resync());
    this.subscriber.on('reconnecting', () => this.resync());
    this.subscriber.on('end', () => this.resync());
  }

  private resync(): void {
    if (this.stopped) return;
    for (const socket of this.subscriptions.reset()) {
      // 전체 Room을 재인가·재조회하도록 연결을 닫는다. 단절 중 Pub/Sub 전달은 복원할 수 없다.
      if (socket.readyState === WebSocket.OPEN)
        socket.close(1012, 'Realtime interrupted; reconnect and reload');
    }
    this.seen.clear();
  }

  async start(): Promise<void> {
    try {
      await Promise.all([
        this.reader.connect(),
        this.publisher.connect(),
        this.subscriber.connect(),
      ]);
      try {
        await this.reader.xGroupCreate(stream, group, '0', { MKSTREAM: true });
      } catch (error) {
        if (!String(error).includes('BUSYGROUP')) throw error;
      }
      await this.subscriber.subscribe(channel, (raw) => this.deliver(raw));
      this.active = true;
      this.running = this.loop();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  ready(): boolean {
    return (
      this.active &&
      this.reader.isReady &&
      this.publisher.isReady &&
      this.subscriber.isReady
    );
  }

  async metrics(): Promise<{
    consumerPending: number;
    deliveryFailures: number;
  }> {
    const pending = await this.reader
      .withCommandOptions({ timeout: 2000 })
      .xPending(stream, group);
    return {
      consumerPending: Number(pending.pending),
      deliveryFailures: this.failures,
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.active = false;
    for (const client of [this.reader, this.publisher, this.subscriber])
      if (client.isOpen) client.destroy();
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const reader = this.reader.withCommandOptions({ timeout: 2500 });
        const claimed = await reader.xAutoClaim(
          stream,
          group,
          this.consumer,
          5000,
          this.cursor,
          { COUNT: 20 },
        );
        this.cursor = claimed.nextId;
        for (const entry of claimed.messages)
          if (entry) await this.process(entry.id, entry.message);
        const batches = (await reader.xReadGroup(
          group,
          this.consumer,
          { key: stream, id: '>' },
          { COUNT: 20, BLOCK: 1000 },
        )) as Array<{
          messages: Array<{ id: string; message: Record<string, string> }>;
        }> | null;
        for (const batch of batches ?? [])
          for (const entry of batch.messages)
            await this.process(entry.id, entry.message);
      } catch {
        if (!this.stopped) {
          this.failures++;
          this.log.warn({
            event: 'realtime_consumer_retry',
            failures: this.failures,
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  }

  private async process(
    id: string,
    fields: Record<string, string>,
  ): Promise<void> {
    try {
      const message = realtimePostEvent(fields);
      if (message) {
        const delivered = await this.publisher
          .withCommandOptions({ timeout: 2000 })
          .eval(publishOrdered, {
            keys: [`post:realtime:state:${message.postId}`],
            arguments: [JSON.stringify(message), channel],
          });
        if (Number(delivered) < 0) throw new Error('No subscribers');
      }
    } catch (error) {
      this.failures++;
      const pending = await this.reader
        .withCommandOptions({ timeout: 2000 })
        .xPendingRange(stream, group, id, id, 1);
      const attempt = pending[0]?.deliveriesCounter ?? 1;
      const invalid = error instanceof InvalidPostEvent;
      this.log.warn({
        event: 'realtime_event_failed',
        streamId: id,
        attempt,
        errorCode: invalid ? 'INVALID_CONTRACT' : 'DELIVERY_FAILED',
      });
      if (!invalid && attempt < 5) return;
      // DLQ 저장 실패에는 ACK하지 않고 다음 회수에서 재시도한다.
      await this.publisher
        .withCommandOptions({ timeout: 2000 })
        .xAdd(deadStream, '*', {
          streamId: id,
          error: invalid ? 'INVALID_CONTRACT' : 'RETRY_EXHAUSTED',
          original: JSON.stringify(fields),
        });
      this.log.warn({ event: 'realtime_event_dead_lettered', streamId: id });
    }
    await this.reader
      .withCommandOptions({ timeout: 2000 })
      .xAck(stream, group, id);
  }

  private deliver(raw: string): void {
    try {
      const message = JSON.parse(raw) as PostRealtimeMessage;
      if (
        message.version !== 1 ||
        typeof message.eventId !== 'string' ||
        typeof message.boardId !== 'string' ||
        message.boardId !== message.postId
      )
        return;
      const now = Date.now();
      // 제한된 중복 전송 억제다. 도메인 순서는 위의 Redis 처리 상태로 판정한다.
      for (const [id, at] of this.seen)
        if (at < now - 300000) this.seen.delete(id);
      if (this.seen.has(message.eventId)) return;
      if (this.seen.size >= 10000)
        this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(message.eventId, now);
      const terminal =
        message.type === 'post.deleted' || message.type === 'post.expired';
      const sockets = [...this.subscriptions.socketsForBoard(message.boardId)];
      // 인가 await 중의 join도 먼저 무효화한다. 다른 Room·영속 참여 정보는 변경하지 않는다.
      if (terminal) this.subscriptions.closeBoard(message.boardId);
      const encoded = JSON.stringify(message);
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try {
          socket.send(encoded, (error) => {
            if (error) {
              this.failures++;
              socket.terminate();
            }
          });
        } catch {
          this.failures++;
          socket.terminate();
        }
      }
    } catch {
      this.log.warn({ event: 'invalid_realtime_message' });
    }
  }
}
