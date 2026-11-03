import { FirebasePushAdapter } from '../../src/firebase/firebase-push.adapter.js';
import type { Messaging } from 'firebase-admin/messaging';
import { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostEventConsumer } from '../../src/event-consumer/post-event.consumer.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
import {
  BusyDeliveryError,
  PostgresEventStore,
} from '../../src/persistence/postgres-event.store.js';
import { wire } from '../helpers/post-events.js';
import { harness } from './harness.js';

const STREAM = 'post:events',
  GROUP = 'post-notification',
  DEAD = 'notification:post:dead';
describe('real Redis + PostgreSQL + mock FCM', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let store: PostgresEventStore;
  let handler: PostEventHandler;
  let consumer: PostEventConsumer;
  let connection: ReturnType<typeof createClient>;
  const send = vi.fn();
  beforeEach(async () => {
    h = await harness();
    [STREAM, DEAD, 'notification:unread:1'].forEach((key) =>
      h.ownedKeys.add(key),
    );
    store = new PostgresEventStore(h.database);
    send.mockReset().mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      invalidTokens: [],
      retryTokens: [],
    });
    handler = new PostEventHandler(store, h.state, { send });
    connection = createClient({
      url: h.config.get<string>('redis.url')!,
      socket: { reconnectStrategy: false },
    });
    connection.on('error', () => undefined);
    await connection.connect();
    consumer = new PostEventConsumer(h.config, handler, connection);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (consumer) await consumer.onModuleDestroy();
    if (h?.redis.isOpen) await h.cleanup();
  });
  async function prepare() {
    await h.redis.xGroupCreate(STREAM, GROUP, '0', { MKSTREAM: true });
  }
  async function input(fields: Record<string, string>) {
    const id = await h.redis.xAdd(STREAM, '*', fields);
    await consumer.pollOnce();
    return id;
  }
  const items = async () => (await h.notifications.list('1', 100)).items;
  const pending = async () => (await h.redis.xPending(STREAM, GROUP)).pending;
  const parsed = (fields: ReturnType<typeof wire>) =>
    parsePostEvent(fields.data, fields)!;
  async function readyDelivery(postId: string) {
    await h.database.pool.query(
      'UPDATE notification_deliveries SET next_attempt_at=0,lease_until=CASE WHEN lease_id IS NULL THEN NULL ELSE 0 END WHERE post_id=$1',
      [postId],
    );
  }

  it('creates the group, consumes a comment, stores unread, pushes, ACKs and shuts down', async () => {
    expect(consumer.isReady()).toBe(false);
    await consumer.onModuleInit();
    expect(consumer.isReady()).toBe(true);
    const fields = wire('PostCommentCreated');
    await h.redis.xAdd(STREAM, '*', fields);
    await expect
      .poll(async () => (await items()).length, { timeout: 5000 })
      .toBe(1);
    await expect.poll(() => pending(), { timeout: 5000 }).toBe(0);
    expect((await h.redis.xInfoGroups(STREAM))[0]?.name).toBe(GROUP);
    expect(await h.redis.xInfoConsumers(STREAM, GROUP)).toHaveLength(1);
    expect(await h.notifications.unread('1')).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect((await items())[0]).toMatchObject({
      type: 'POST_COMMENTED',
      count: 1,
      commentId: JSON.parse(fields.data).comment.commentId,
    });
    await consumer.onModuleDestroy();
    expect(connection.isOpen).toBe(false);
    expect(consumer.isReady()).toBe(false);
  });

  it.each(['CURIOUS', 'STILL_HAPPENING', 'HELPFUL', 'ENDED', 'LIKE'])(
    'notifies the author for %s and excludes self actions',
    async (reactionType) => {
      await prepare();
      await input(wire('PostReactionCreated', { reactionType, actor: 1 }));
      expect(await items()).toHaveLength(0);
      const fields = wire('PostReactionCreated', { reactionType });
      await input(fields);
      expect((await items())[0]).toMatchObject({
        type: 'POST_REACTED',
        count: 1,
      });
      expect(
        await store.postState(parsed(fields).aggregateId),
      ).not.toMatchObject({ closed: true });
      expect(send).toHaveBeenCalledOnce();
      expect(await pending()).toBe(0);
    },
  );

  it('deduplicates events/count across Redis loss and handler restart and expires the two minute window', async () => {
    await prepare();
    const first = wire('PostCommentCreated');
    const postId = parsed(first).aggregateId;
    await input(first);
    await input(first);
    const second = wire('PostCommentCreated', { postId, actor: 3 });
    await input(second);
    await input(second);
    expect((await items())[0]?.count).toBe(2);
    expect(send).toHaveBeenCalledOnce();
    await h.redis.del('notification:unread:1');
    const restarted = new PostEventHandler(
      new PostgresEventStore(h.database),
      h.state,
      { send },
    );
    await restarted.handle(parsed(second));
    expect((await items())[0]?.count).toBe(2);
    expect(send).toHaveBeenCalledOnce();
    await store.apply(
      parsed(wire('PostCommentCreated', { postId, actor: 4 })),
      new Date(Date.now() + 121_000),
    );
    await handler.dispatch(postId);
    expect(await items()).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('recovers a failed DB commit despite a Redis window reservation without missing a notification', async () => {
    await prepare();
    const fields = wire('PostCommentCreated');
    const postId = parsed(fields).aggregateId;
    h.ownedKeys.add(`notification:bundle:1:${postId}:POST_COMMENTED`);
    await h.state.reserveBundle('1', postId, 'POST_COMMENTED', 'not-durable');
    await h.database.pool.query(
      'ALTER TABLE notification_processed_events ADD CONSTRAINT fail_commit CHECK (false)',
    );
    await input(fields);
    expect(await pending()).toBe(1);
    expect(await items()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    await h.database.pool.query(
      'ALTER TABLE notification_processed_events DROP CONSTRAINT fail_commit',
    );
    await consumer.onModuleDestroy();
    const recovered = new PostEventConsumer(h.config, handler);
    await recovered.onModuleInit();
    try {
      await expect.poll(() => pending(), { timeout: 5000 }).toBe(0);
    } finally {
      await recovered.onModuleDestroy();
    }
    expect(await items()).toHaveLength(1);
    expect((await items())[0]?.count).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it('recovers consumer A PEL with XAUTOCLAIM after interruption and an abandoned Redis claim', async () => {
    await prepare();
    const fields = wire('PostCommentCreated');
    h.ownedKeys.add(`notification:dedup:${fields.eventId}:1`);
    await h.state.claim(fields.eventId, '1');
    await h.redis.xAdd(STREAM, '*', fields);
    await h.redis.xReadGroup(GROUP, 'consumer-A', { key: STREAM, id: '>' });
    expect(await pending()).toBe(1);
    await consumer.pollOnce();
    expect(await pending()).toBe(0);
    expect(await items()).toHaveLength(1);
    expect(
      (await h.redis.xInfoConsumers(STREAM, GROUP)).some((c) =>
        c.name.startsWith('notification-'),
      ),
    ).toBe(true);
  });

  it('serializes simultaneous workers with post row locks and creates one bundle with two contributions', async () => {
    const first = parsed(wire('PostCommentCreated'));
    const postId = first.aggregateId;
    const second = parsed(wire('PostCommentCreated', { postId, actor: 3 }));
    const other = new PostgresEventStore(h.database);
    await Promise.all([
      store.apply(first),
      other.apply(first),
      store.apply(second),
      other.apply(second),
    ]);
    expect(await items()).toHaveLength(1);
    expect((await items())[0]?.count).toBe(2);
    await handler.dispatch(postId);
    expect(send).toHaveBeenCalledOnce();
  });

  it('leaves a busy duplicate pending while another worker owns a durable delivery lease', async () => {
    await prepare();
    const fields = wire('PostCommentCreated');
    const postId = parsed(fields).aggregateId;
    await store.apply(parsed(fields));
    await store.acquire((await store.deliveries(postId))[0]!);
    await input(fields);
    expect(await pending()).toBe(1);
    expect(send).not.toHaveBeenCalled();
    await readyDelivery(postId);
    await consumer.pollOnce();
    expect(await pending()).toBe(0);
    expect(send).toHaveBeenCalledOnce();
    expect((await items())[0]?.count).toBe(1);
  });

  it('removes a reaction once, handles reversed delivery and supports re-registration versions', async () => {
    await prepare();
    const first = wire('PostReactionCreated');
    const postId = parsed(first).aggregateId;
    await input(first);
    const removed = wire('PostReactionRemoved', { postId });
    await input(removed);
    await input(removed);
    await input(first);
    expect(await items()).toHaveLength(0);
    expect(await h.notifications.unread('1')).toBe(0);
    await input(wire('PostReactionCreated', { postId, version: 3 }));
    expect((await items())[0]?.count).toBe(1);
    const reversed = wire('PostReactionRemoved');
    await input(reversed);
    await input(
      wire('PostReactionCreated', { postId: parsed(reversed).aggregateId }),
    );
    expect(await items()).toHaveLength(1);
  });

  it('subtracts deleted comments, hides zero count, cancels unsent push and audits Moderation reason', async () => {
    const first = parsed(
      wire('PostCommentCreated', { commentId: 'comment_1' }),
    );
    const postId = first.aggregateId;
    await store.apply(first);
    await store.apply(
      parsed(
        wire('PostCommentCreated', {
          postId,
          actor: 3,
          commentId: 'comment_2',
        }),
      ),
    );
    const removed = parsed(
      wire('PostCommentDeleted', {
        postId,
        commentId: 'comment_1',
        moderation: true,
      }),
    );
    await handler.handle(removed);
    expect((await items())[0]?.count).toBe(1);
    expect((await items())[0]?.commentId).toBeUndefined();
    expect(send.mock.calls[0]?.[0].data.commentId).toBeUndefined();
    expect(
      send.mock.calls.some(
        (call) =>
          call[0].data.type === 'CONTENT_REMOVED' && call[0].userId === '2',
      ),
    ).toBe(true);
    expect(await store.processedEvent(postId, removed.eventId)).toMatchObject({
      reason: 'MODERATION_VIOLATION',
      actorType: 'MODERATION',
    });
    const other = parsed(
      wire('PostCommentCreated', { commentId: 'comment_3' }),
    );
    await store.apply(other);
    await handler.handle(
      parsed(
        wire('PostCommentDeleted', {
          postId: other.aggregateId,
          commentId: 'comment_3',
        }),
      ),
    );
    expect(send).toHaveBeenCalledTimes(2);
    const unseen = parsed(
      wire('PostCommentDeleted', { commentId: 'comment_late' }),
    );
    await handler.handle(unseen);
    await handler.handle(
      parsed(
        wire('PostCommentCreated', {
          postId: unseen.aggregateId,
          commentId: 'comment_late',
        }),
      ),
    );
    expect(await items()).toHaveLength(1);
  });

  it.each(['PostDeleted', 'PostExpired'] as const)(
    'stops queued and late activities after %s and announces only confirmed expiry',
    async (type) => {
      const first = parsed(wire('PostCommentCreated'));
      const postId = first.aggregateId;
      await store.apply(first);
      await handler.handle(parsed(wire(type, { postId })));
      await handler.handle(
        parsed(wire('PostCommentCreated', { postId, actor: 3 })),
      );
      await handler.handle(
        parsed(wire('PostCreated', { postId, postVersion: 1 })),
      );
      expect(send).toHaveBeenCalledTimes(type === 'PostExpired' ? 1 : 0);
      expect((await items())[0]?.count).toBe(1);
      expect(await items()).toHaveLength(type === 'PostExpired' ? 2 : 1);
      expect(await store.deliveries(postId)).toHaveLength(0);
      expect(await store.postState(postId)).toMatchObject({
        closed: true,
        post_version: 2,
        terminal_type: type,
      });
    },
  );

  it('does not treat participants as subscribers and resolves legacy recipients only from a real projection', async () => {
    await prepare();
    await input(wire('PostParticipantJoined'));
    await input(wire('PostParticipantLeft'));
    expect(await items()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    const legacy = wire('PostCommentCreated', { legacy: true });
    await input(legacy);
    expect(await pending()).toBe(1);
    expect(await items()).toHaveLength(0);
    await input(
      wire('PostCreated', { postId: parsed(legacy).aggregateId, legacy: true }),
    );
    await consumer.pollOnce();
    expect(await pending()).toBe(0);
    expect(await items()).toHaveLength(1);
  });

  it('dead-letters malformed/invalid supported events and retains pending when DLQ write fails', async () => {
    await prepare();
    const base = wire('PostCommentCreated');
    for (const message of [
      { ...base, data: '{' },
      {
        ...base,
        data: JSON.stringify({ ...JSON.parse(base.data), producer: 'wrong' }),
      },
      {
        ...base,
        data: JSON.stringify({ ...JSON.parse(base.data), schemaVersion: 2 }),
      },
      {
        ...base,
        data: JSON.stringify({ ...JSON.parse(base.data), comment: {} }),
      },
      { ...base, eventId: 'wrong' },
    ])
      await input(message);
    expect(await h.redis.xLen(DEAD)).toBe(5);
    expect(await pending()).toBe(0);
    expect(
      (await h.redis.xRange(DEAD, '-', '+')).every(
        (row) =>
          row.message.eventId &&
          row.message.error?.startsWith('Error: Invalid'),
      ),
    ).toBe(true);
    const spy = vi
      .spyOn(connection, 'xAdd')
      .mockRejectedValueOnce(new Error('DLQ offline'));
    const id = await h.redis.xAdd(STREAM, '*', { ...base, data: '{' });
    await expect(consumer.pollOnce()).rejects.toThrow('DLQ offline');
    expect(await pending()).toBe(1);
    spy.mockRestore();
    await consumer.pollOnce();
    expect(await pending()).toBe(0);
    expect(
      (await h.redis.xRange(DEAD, '-', '+')).at(-1)?.message.streamId,
    ).toBe(id);
  });

  it('dead-letters a poison event after exactly five Redis deliveries', async () => {
    await prepare();
    await input(wire('PostCommentCreated', { legacy: true }));
    for (let attempt = 2; attempt <= 5; attempt++) {
      expect(await pending()).toBe(1);
      expect(await h.redis.xLen(DEAD)).toBe(0);
      await consumer.pollOnce();
    }
    expect(await pending()).toBe(0);
    expect(await h.redis.xLen(DEAD)).toBe(1);
    expect(await items()).toHaveLength(0);
  });

  it('persists before push, retries only failed tokens, and does not resend after ACK failure', async () => {
    await prepare();
    const fields = wire('PostCommentCreated');
    const postId = parsed(fields).aggregateId;
    send.mockResolvedValueOnce({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      invalidTokens: [],
      retryTokens: ['retry-only'],
    });
    await input(fields);
    expect(await pending()).toBe(1);
    expect((await items())[0]?.count).toBe(1);
    const restarted = new PostEventHandler(
      new PostgresEventStore(h.database),
      h.state,
      { send },
    );
    await readyDelivery(postId);
    await restarted.dispatch(postId);
    expect(send.mock.calls[1]?.[0].tokens).toEqual(['retry-only']);
    const ack = vi
      .spyOn(connection, 'xAck')
      .mockRejectedValueOnce(new Error('ACK offline'));
    await consumer.pollOnce();
    expect(await pending()).toBe(1);
    ack.mockRestore();
    await consumer.pollOnce();
    expect(await pending()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await items())[0]?.count).toBe(1);
  });

  it('recovers a commit-before-push crash and keeps notificationId stable if push succeeded but the receipt was lost', async () => {
    const fields = wire('PostCommentCreated');
    const postId = parsed(fields).aggregateId;
    await store.apply(parsed(fields));
    expect(send).not.toHaveBeenCalled();
    const finish = vi
      .spyOn(store, 'finish')
      .mockRejectedValueOnce(new Error('receipt lost'));
    await expect(handler.dispatch(postId)).rejects.toThrow('receipt lost');
    finish.mockRestore();
    await readyDelivery(postId);
    const restarted = new PostEventHandler(
      new PostgresEventStore(h.database),
      h.state,
      { send },
    );
    await restarted.dispatch(postId);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].data.notificationId).toBe(
      send.mock.calls[1]?.[0].data.notificationId,
    );
    expect((await items())[0]?.count).toBe(1);
  });

  it('retries unknown transport failures durably and records permanent failures without retrying', async () => {
    const fields = wire('PostCommentCreated');
    const postId = parsed(fields).aggregateId;
    send.mockRejectedValueOnce(new Error('FCM transport offline'));
    await expect(handler.handle(parsed(fields))).rejects.toThrow(
      'FCM transport offline',
    );
    expect(await items()).toHaveLength(1);
    expect(await store.deliveries(postId)).toHaveLength(1);
    await readyDelivery(postId);
    await handler.dispatch(postId);
    const second = parsed(wire('PostCommentCreated'));
    send.mockResolvedValueOnce({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      invalidTokens: [],
      retryTokens: [],
      permanentTokens: ['bad'],
    });
    await handler.handle(second);
    expect(await store.deliveries(second.aggregateId)).toHaveLength(0);
    expect(
      await store.delivery(
        second.aggregateId,
        `delivery#${send.mock.calls.at(-1)![0].data.notificationId}`,
      ),
    ).toMatchObject({ status: 'FAILED' });
  });

  it('keeps unread correct when Redis cache is unavailable', async () => {
    const original = h.stateClient.connect.bind(h.stateClient);
    const spy = vi
      .spyOn(h.stateClient, 'connect')
      .mockRejectedValue(new Error('Redis cache offline'));
    await handler.handle(parsed(wire('PostCommentCreated')));
    expect(await h.notifications.unread('1')).toBe(1);
    spy.mockRestore();
    await original();
    expect(await h.notifications.unread('1')).toBe(1);
  });

  it('rejects stale lease completion after a second worker recovers the delivery', async () => {
    const event = parsed(wire('PostCommentCreated'));
    await store.apply(event);
    const pending = (await store.deliveries(event.aggregateId))[0]!;
    const first = (await store.acquire(pending))!;
    await readyDelivery(event.aggregateId);
    const second = (await store.acquire(pending))!;
    expect(second.leaseId).not.toBe(first.leaseId);
    await expect(store.finish(first, 'SENT')).rejects.toBeInstanceOf(
      BusyDeliveryError,
    );
    await store.finish(second, 'SENT');
    expect(await store.deliveries(event.aggregateId)).toHaveLength(0);
  });

  it('does not acquire a stale delivery snapshot after a post deletion commits', async () => {
    const first = parsed(wire('PostCommentCreated'));
    await store.apply(first);
    const work = (await store.deliveries(first.aggregateId))[0]!;
    await store.apply(
      parsed(wire('PostDeleted', { postId: first.aggregateId })),
    );
    expect(await store.acquire(work)).toBeUndefined();
    await handler.dispatch(first.aggregateId);
    expect(send).not.toHaveBeenCalled();
    expect(await store.deliveries(first.aggregateId)).toHaveLength(0);
  });

  it('does not increase a bundle twice after a committed transaction response is lost', async () => {
    await prepare();
    const first = wire('PostCommentCreated');
    await input(first);
    const next = wire('PostCommentCreated', {
      postId: parsed(first).aggregateId,
      actor: 3,
    });
    const original = h.database.transaction.bind(h.database);
    const spy = vi
      .spyOn(h.database, 'transaction')
      .mockImplementationOnce(async (work) => {
        await original(work);
        throw new Error('commit response lost');
      });
    await input(next);
    expect(await pending()).toBe(1);
    expect((await items())[0]?.count).toBe(2);
    spy.mockRestore();
    await consumer.pollOnce();
    expect(await pending()).toBe(0);
    expect((await items())[0]?.count).toBe(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it('integrates the production Firebase adapter with real subscriptions, partial response retry and invalid token cleanup', async () => {
    for (const token of ['valid', 'invalid', 'temporary'])
      await h.subscriptions.upsert('1', token, 'web');
    const sendEachForMulticast = vi
      .fn()
      .mockResolvedValueOnce({
        successCount: 1,
        failureCount: 2,
        responses: [
          {
            success: false,
            error: { code: 'messaging/registration-token-not-registered' },
          },
          { success: false, error: { code: 'messaging/server-unavailable' } },
          { success: true },
        ],
      })
      .mockResolvedValueOnce({
        successCount: 1,
        failureCount: 0,
        responses: [{ success: true }],
      });
    // 저장소의 token 정렬 순서에 맞춰 FCM 부분 응답을 만든다.
    const adapter = new FirebasePushAdapter(h.config, h.subscriptions, {
      sendEachForMulticast,
    } as unknown as Messaging);
    const integrated = new PostEventHandler(store, h.state, adapter);
    const first = parsed(wire('PostCommentCreated'));
    await expect(integrated.handle(first)).rejects.toThrow('Transient push');
    expect((await h.subscriptions.list('1')).map((s) => s.token)).toEqual([
      'temporary',
      'valid',
    ]);
    await readyDelivery(first.aggregateId);
    await integrated.dispatch(first.aggregateId);
    expect(sendEachForMulticast.mock.calls[1]?.[0].tokens).toEqual([
      'temporary',
    ]);
    expect((await items())[0]?.count).toBe(1);
  });
});
