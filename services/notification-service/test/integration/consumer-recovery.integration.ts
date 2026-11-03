import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { DurableStreamConsumer } from '../../src/event-consumer/durable-stream.consumer.js';
import { NotificationEventWriter } from '../../src/persistence/notification-event.writer.js';
import { UserEventHandler } from '../../src/event-consumer/user-event.handler.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import { PostEventConsumer } from '../../src/event-consumer/post-event.consumer.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
import { replayFields } from '../../src/event-consumer/replay.js';
import { wire } from '../helpers/post-events.js';

describe('durable stream cutoff, ACK outage, DLQ replay and identity fencing', () => {
  let h: Awaited<ReturnType<typeof harness>>,
    store: PostgresEventStore,
    post: PostEventHandler;
  const send = vi.fn();
  const consumers: Array<{ onModuleDestroy(): Promise<void> }> = [];
  beforeEach(async () => {
    h = await harness();
    store = new PostgresEventStore(h.database);
    send.mockReset().mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      invalidTokens: [],
      retryTokens: [],
    });
    post = new PostEventHandler(store, h.state, { send });
    [
      'user:events',
      'post:events',
      'notification:user:dead',
      'notification:post:dead',
    ].forEach((k) => h.ownedKeys.add(k));
  });
  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.onModuleDestroy()));
    await h.cleanup();
  });
  const userFields = () => {
    const eventId = randomUUID();
    return {
      eventId,
      eventType: 'USER_BADGE_GRANTED',
      data: JSON.stringify({
        eventId,
        type: 'USER_BADGE_GRANTED',
        version: 1,
        producer: 'user-service',
        target: { type: 'USER', id: '42' },
        occurredAt: new Date().toISOString(),
        correlationId: 'test',
        payload: {
          userId: '42',
          sourceEventId: randomUUID(),
          policyVersion: 'wgo-titles-v2',
          badgeId: '1',
        },
      }),
    };
  };
  function userConsumer(handle: (f: Record<string, string>) => Promise<void>) {
    const c = new DurableStreamConsumer(
      h.database,
      {
        url: h.config.get('redis.url')!,
        stream: 'user:events',
        group: 'user-notification',
        dead: 'notification:user:dead',
        pendingIdleMs: 0,
        blockMs: 1,
      },
      handle,
    );
    consumers.push(c);
    return c;
  }
  it('never DLQs committed events after six ACK failures and preserves single push', async () => {
    const handler = new UserEventHandler(
        new NotificationEventWriter(h.database),
        h.state,
        post,
      ),
      consumer = userConsumer((f) => handler.handle(f));
    await consumer.initialize();
    await h.redis.xAdd('user:events', '*', userFields());
    const ack = vi
      .spyOn(consumer.redis, 'xAck')
      .mockRejectedValue(new Error('ACK offline'));
    for (let n = 0; n < 6; n++)
      await expect(consumer.pollOnce()).rejects.toThrow('ACK offline');
    expect(await h.redis.xLen('notification:user:dead')).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect((await h.notifications.list('42')).items).toHaveLength(1);
    ack.mockRestore();
    await consumer.pollOnce();
    expect(
      (await h.redis.xPending('user:events', 'user-notification')).pending,
    ).toBe(0);
  });
  it('atomically quarantines five failures and replays a valid original event ID without deleting the DLQ', async () => {
    let failing = true;
    const handler = new UserEventHandler(
        new NotificationEventWriter(h.database),
        h.state,
        post,
      ),
      consumer = userConsumer(async (f) => {
        if (failing) throw new Error('dependency down');
        await handler.handle(f);
      });
    await consumer.initialize();
    const event = userFields();
    await h.redis.xAdd('user:events', '*', event);
    for (let n = 0; n < 5; n++) await consumer.pollOnce();
    const dead = (await h.redis.xRange('notification:user:dead', '-', '+'))[0]!;
    expect(dead.message.eventId).toBe(event.eventId);
    expect(
      (await h.redis.xPending('user:events', 'user-notification')).pending,
    ).toBe(0);
    failing = false;
    await h.redis.xAdd(
      'user:events',
      '*',
      replayFields('user:events', dead.message),
    );
    await consumer.pollOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(await h.redis.xLen('notification:user:dead')).toBe(1);
    expect((await h.notifications.list('42')).items).toHaveLength(1);
  });
  it('does not replay historical notifications for a new Post group and durably records valid unsupported facts', async () => {
    await h.redis.xAdd('post:events', '*', wire('PostCommentCreated'));
    const consumer = new PostEventConsumer(
      h.config,
      post,
      undefined,
      h.database,
    );
    consumers.push(consumer);
    await consumer.worker!.initialize();
    await consumer.pollOnce();
    expect(send).not.toHaveBeenCalled();
    const f = wire('PostCreated'),
      data = { ...JSON.parse(f.data), eventType: 'FuturePostFact' };
    await h.redis.xAdd('post:events', '*', {
      ...f,
      eventType: 'FuturePostFact',
      data: JSON.stringify(data),
    });
    await consumer.pollOnce();
    expect(
      (
        await h.database.pool.query(
          'SELECT details FROM notification_event_inbox',
        )
      ).rows,
    ).toEqual([{ details: { eventType: 'FuturePostFact', ignored: true } }]);
    expect(
      (await h.database.pool.query('SELECT * FROM notification_posts'))
        .rowCount,
    ).toBe(0);
  });
  it('preserves pre-existing Post group pending work and reuses its persisted start on group recovery', async () => {
    await h.redis.xGroupCreate('post:events', 'post-notification', '0-0', {
      MKSTREAM: true,
    });
    await h.redis.xAdd('post:events', '*', wire('PostCommentCreated'));
    await h.redis.xReadGroup('post-notification', 'old-pod', {
      key: 'post:events',
      id: '>',
    });
    const consumer = new PostEventConsumer(
      h.config,
      post,
      undefined,
      h.database,
    );
    consumers.push(consumer);
    await consumer.worker!.initialize();
    await consumer.pollOnce();
    expect(send).toHaveBeenCalledOnce();
    await h.redis.xGroupDestroy('post:events', 'post-notification');
    await consumer.worker!.initialize();
    await consumer.pollOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(
      (
        await h.database.pool.query(
          'SELECT start_id FROM notification_stream_starts',
        )
      ).rows[0].start_id,
    ).toBe('0-0');
  });
  it('fences the same Post event ID across conflicting aggregate IDs', async () => {
    const first = parsePostEvent(wire('PostCommentCreated').data)!,
      other = { ...first, aggregateId: 'post_conflict' };
    const results = await Promise.allSettled([
      store.apply(first),
      store.apply(other),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (await h.database.pool.query('SELECT * FROM notifications')).rowCount,
    ).toBe(1);
  });
});
