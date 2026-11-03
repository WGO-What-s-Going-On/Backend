import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { UserEventHandler } from '../../src/event-consumer/user-event.handler.js';
import { DurableStreamConsumer } from '../../src/event-consumer/durable-stream.consumer.js';
import { NotificationEventWriter } from '../../src/persistence/notification-event.writer.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';

describe('User stream → PostgreSQL inbox → mock FCM', () => {
  let h: Awaited<ReturnType<typeof harness>>,
    handler: UserEventHandler,
    consumer: DurableStreamConsumer;
  const send = vi.fn();
  function fields(type: string, payload: Record<string, unknown> = {}) {
    const eventId = randomUUID();
    return {
      eventId,
      eventType: type,
      data: JSON.stringify({
        eventId,
        type,
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
          ...payload,
        },
      }),
    };
  }
  const items = async () => (await h.notifications.list('42', 100)).items;
  beforeEach(async () => {
    h = await harness();
    ['user:events', 'notification:user:dead', 'notification:unread:42'].forEach(
      (k) => h.ownedKeys.add(k),
    );
    send
      .mockReset()
      .mockResolvedValue({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        invalidTokens: [],
        retryTokens: [],
      });
    handler = new UserEventHandler(
      new NotificationEventWriter(h.database),
      h.state,
      new PostEventHandler(new PostgresEventStore(h.database), h.state, {
        send,
      }),
    );
    consumer = new DurableStreamConsumer(
      h.database,
      {
        url: h.config.get('redis.url')!,
        stream: 'user:events',
        group: 'user-notification',
        dead: 'notification:user:dead',
        blockMs: 1,
        pendingIdleMs: 0,
      },
      (f) => handler.handle(f),
    );
  });
  afterEach(async () => {
    await consumer.onModuleDestroy();
    await h.cleanup();
  });
  it.each([
    ['NEWS_BOY', '소식통'],
    ['REPORTER', '리포터'],
    ['CORRESPONDENT', '특파원'],
  ])(
    'delivers own %s acquisition once without a fake post ID',
    async (badgeCode, badgeName) => {
      await consumer.initialize();
      const f = fields('USER_BADGE_GRANTED', { badgeCode, badgeName });
      await h.redis.xAdd('user:events', '*', f);
      await consumer.pollOnce();
      await handler.handle(f);
      expect((await items())[0]).toMatchObject({
        type: 'USER_BADGE_GRANTED',
        actorId: null,
        metadata: { badgeCode, badgeName },
      });
      expect(await h.notifications.unread('42')).toBe(1);
      expect(send).toHaveBeenCalledOnce();
      expect(
        (
          await h.database.pool.query(
            'SELECT post_id,status FROM notification_deliveries',
          )
        ).rows,
      ).toEqual([{ post_id: null, status: 'SENT' }]);
      expect(
        (await h.redis.xPending('user:events', 'user-notification')).pending,
      ).toBe(0);
    },
  );
  it('distinguishes regional grants/revocations and preserves null regionName', async () => {
    const common = {
      badgeCode: 'CLAIRVOYANT',
      badgeName: '천리안',
      regionName: null,
      rankingRunId: randomUUID(),
      rank: '1',
      score: '3',
    };
    await handler.handle(
      fields('USER_BADGE_GRANTED', { ...common, regionCode: '1159053000' }),
    );
    await handler.handle(
      fields('USER_BADGE_GRANTED', { ...common, regionCode: '1159054000' }),
    );
    await handler.handle(
      fields('USER_BADGE_REVOKED', { ...common, regionCode: '1159053000' }),
    );
    expect(await items()).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await items()).every((n) => n.metadata?.regionName === null)).toBe(
      true,
    );
    expect(
      (await items()).filter((n) => n.metadata?.regionCode === '1159053000'),
    ).toHaveLength(2);
  });
  it('suppresses INITIAL and credit, pushes only UP and records all legitimate ignored events', async () => {
    await handler.handle(
      fields('USER_LEVEL_CHANGED', {
        changeType: 'INITIAL',
        previousLevel: null,
        level: 0,
      }),
    );
    await handler.handle(
      fields('USER_LEVEL_CHANGED', {
        changeType: 'UP',
        previousLevel: 0,
        level: 2,
      }),
    );
    await handler.handle(
      fields('USER_LEVEL_CHANGED', {
        changeType: 'DOWN',
        previousLevel: 2,
        level: 1,
      }),
    );
    await handler.handle(
      fields('USER_CREDIT_CHANGED', {
        ledgerId: '1',
        delta: '2',
        credits: '2',
        growthScore: '2',
      }),
    );
    expect(await items()).toHaveLength(2);
    expect(send).toHaveBeenCalledOnce();
    expect(
      (await h.database.pool.query('SELECT * FROM notification_event_inbox'))
        .rowCount,
    ).toBe(4);
  });
  it('starts at a durable deployment cutoff and preserves original IDs in the DLQ', async () => {
    await h.redis.xAdd('user:events', '*', fields('USER_BADGE_GRANTED'));
    await consumer.initialize();
    await consumer.pollOnce();
    expect(await items()).toHaveLength(0);
    const invalid = fields('USER_LEVEL_CHANGED', {
      changeType: 'UP',
      previousLevel: 3,
      level: 1,
    });
    await h.redis.xAdd('user:events', '*', invalid);
    await consumer.pollOnce();
    expect(
      (await h.redis.xRange('notification:user:dead', '-', '+'))[0]?.message
        .eventId,
    ).toBe(invalid.eventId);
    const fresh = fields('USER_BADGE_GRANTED');
    await h.redis.xAdd('user:events', '*', fresh);
    await consumer.pollOnce();
    expect(await items()).toHaveLength(1);
    const checkpoint = (
      await h.database.pool.query(
        'SELECT start_id FROM notification_stream_starts',
      )
    ).rows[0].start_id;
    await consumer.initialize();
    expect(
      (
        await h.database.pool.query(
          'SELECT start_id FROM notification_stream_starts',
        )
      ).rows[0].start_id,
    ).toBe(checkpoint);
  });
  it('rolls back all notification and delivery writes before receipt commit and retries without duplication', async () => {
    const event = fields('USER_BADGE_GRANTED');
    await h.database.pool.query(
      'ALTER TABLE notification_event_inbox ADD CONSTRAINT fail_receipt CHECK(false)',
    );
    await expect(handler.handle(event)).rejects.toThrow();
    expect(await items()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    await h.database.pool.query(
      'ALTER TABLE notification_event_inbox DROP CONSTRAINT fail_receipt',
    );
    await Promise.all([handler.handle(event), handler.handle(event)]).catch(
      () => undefined,
    );
    expect(await items()).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });
  it('respects reward settings for both inbox and push', async () => {
    await new PostgresEventStore(h.database).savePreferences('42', {
      rewards: false,
    });
    await handler.handle(fields('USER_BADGE_GRANTED'));
    expect(await items()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(
      (await h.database.pool.query('SELECT * FROM notification_event_inbox'))
        .rowCount,
    ).toBe(1);
  });
});
