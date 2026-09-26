import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import type { SubscriptionManager } from './subscription-manager.js';
import { WebSocket } from 'ws';

const stream = 'post:events';
const group = 'post-realtime';
const channel = 'post:realtime';

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
  private readonly seen = new Map<string, number>();
  private failures = 0;

  constructor(redisUrl: string, private readonly subscriptions: SubscriptionManager, private readonly log: { warn(value: unknown): void }) {
    this.reader = createClient({ url: redisUrl });
    this.publisher = createClient({ url: redisUrl });
    this.subscriber = createClient({ url: redisUrl });
    for (const client of [this.reader, this.publisher, this.subscriber]) client.on('error', (error) => this.log.warn(error));
  }

  async start(): Promise<void> {
    await Promise.all([this.reader.connect(), this.publisher.connect(), this.subscriber.connect()]);
    // 그룹이 처음 만들어질 때는 보관 중인 Stream 이벤트부터 읽는다.
    try { await this.reader.xGroupCreate(stream, group, '0', { MKSTREAM: true }); }
    catch (error) { if (!String(error).includes('BUSYGROUP')) throw error; }
    await this.subscriber.subscribe(channel, (raw) => this.deliver(raw));
    this.active = true;
    void this.loop();
  }

  ready(): boolean { return this.active && this.reader.isReady && this.publisher.isReady && this.subscriber.isReady; }

  async metrics(): Promise<{ consumerPending: number; deliveryFailures: number }> {
    const pending = await this.reader.xPending(stream, group);
    return { consumerPending: Number(pending.pending), deliveryFailures: this.failures };
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.active = false;
    await Promise.all([this.reader, this.publisher, this.subscriber].map(async (client) => { if (client.isOpen) await client.quit(); }));
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        // ACK 전에 소비자가 죽은 이벤트를 먼저 회수한 뒤 새 이벤트를 읽는다.
        const claimed = await this.reader.sendCommand(['XAUTOCLAIM', stream, group, this.consumer, '5000', '0-0', 'COUNT', '20']) as unknown[];
        const pending = Array.isArray(claimed?.[1]) ? claimed[1] as unknown[] : [];
        for (const entry of pending) await this.processRaw(entry);
        const batches = await this.reader.xReadGroup(group, this.consumer, { key: stream, id: '>' }, { COUNT: 20, BLOCK: 1000 });
        if (Array.isArray(batches)) for (const batch of batches as Array<{ messages: Array<{ id: string; message: Record<string, string> }> }>) for (const message of batch.messages) await this.process(message.id, message.message.data);
      } catch (error) {
        if (!this.stopped) { this.failures++; this.log.warn({ error, failures: this.failures }); await new Promise((resolve) => setTimeout(resolve, 500)); }
      }
    }
  }

  private async processRaw(entry: unknown): Promise<void> {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return;
    const fields = entry[1] as string[];
    const index = fields.indexOf('data');
    if (index >= 0) await this.process(entry[0], fields[index + 1]);
  }

  private async process(id: string, raw: string | undefined): Promise<void> {
    if (!raw) { await this.reader.xAck(stream, group, id); return; }
    const event = JSON.parse(raw) as Record<string, unknown>;
    const postId = event.aggregateId;
    const eventId = event.eventId;
    if (typeof postId !== 'string' || typeof eventId !== 'string') throw new Error('Invalid post event');
    let message: Record<string, unknown>;
    switch (event.eventType) {
      case 'PostCommentCreated':
        if (!event.comment || typeof event.comment !== 'object') throw new Error('Invalid comment event');
        message = { type: 'comment.created', comment: event.comment }; break;
      case 'PostCreated': message = { type: 'post.created' }; break;
      case 'PostReactionCreated': message = { type: 'post.reaction.created' }; break;
      case 'PostParticipantJoined': message = { type: 'post.participant.joined' }; break;
      default: await this.reader.xAck(stream, group, id); return;
    }
    // 모든 Gateway 인스턴스가 같은 Pub/Sub 채널을 듣는다. 게시 후에 ACK해야 실패 시 재시도할 수 있다.
    const subscribers = await this.publisher.publish(channel, JSON.stringify({ version: 1, eventId, postId, boardId: postId, ...message }));
    if (subscribers === 0) throw new Error('No realtime subscribers; leaving event pending for retry');
    await this.reader.xAck(stream, group, id);
  }

  private deliver(raw: string): void {
    try {
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (typeof message.eventId !== 'string' || typeof message.boardId !== 'string') return;
      const commentId = message.type === 'comment.created' && typeof (message.comment as Record<string, unknown>)?.commentId === 'string'
        ? String((message.comment as Record<string, unknown>).commentId) : undefined;
      const key = commentId ?? message.eventId;
      const now = Date.now();
      // Stream 재전달이나 ACK 실패로 같은 이벤트가 다시 게시돼도 이 인스턴스에서는 한 번만 보낸다.
      if (this.seen.has(key)) return;
      this.seen.set(key, now);
      for (const [id, at] of this.seen) if (at < now - 300_000) this.seen.delete(id);
      const encoded = JSON.stringify(message);
      for (const socket of this.subscriptions.socketsForBoard(message.boardId)) {
        if (socket.readyState === WebSocket.OPEN) socket.send(encoded, (error) => { if (error) { this.failures++; this.log.warn(error); } });
      }
    } catch (error) { this.log.warn(error); }
  }
}
