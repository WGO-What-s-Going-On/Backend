import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { ModerationEventHandler } from '../../src/event-consumer/moderation-event.handler.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { NotificationEventWriter } from '../../src/persistence/notification-event.writer.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
import { wire } from '../helpers/post-events.js';

describe('Moderation decisions and confirmed Post applications', () => {
  let h: Awaited<ReturnType<typeof harness>>,
    store: PostgresEventStore,
    handler: ModerationEventHandler,
    delivery: PostEventHandler;
  const send = vi.fn(),
    postId = 'post_lifecycle';
  const fields = (eventType: string, extra: Record<string, unknown> = {}) => {
    const eventId = `evt_${randomUUID()}`;
    return {
      eventId,
      eventType,
      data: JSON.stringify({
        eventId,
        eventType,
        schemaVersion: 1,
        producer: 'moderation-service',
        occurredAt: new Date().toISOString(),
        correlationId: 'test',
        ...extra,
      }),
    };
  };
  const lifecycle = (
    type = 'BOARD_STALE',
    version = 1,
    deadline = new Date(Date.now() + 600000).toISOString(),
  ) =>
    fields(type, {
      aggregateId: postId,
      payload: {
        postId,
        state:
          type === 'BOARD_STALE'
            ? 'STALE'
            : type === 'BOARD_REACTIVATED'
              ? 'ACTIVE'
              : 'CLOSED',
        version,
        postAuthorId: '1',
        scheduledCloseAt: type === 'BOARD_STALE' ? deadline : null,
      },
    });
  const items = async (userId = '1') =>
    (await h.notifications.list(userId, 100)).items;
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
    delivery = new PostEventHandler(store, h.state, { send });
    handler = new ModerationEventHandler(
      new NotificationEventWriter(h.database),
      h.state,
      { dispatch: async () => {} } as PostEventHandler,
    );
  });
  afterEach(async () => {
    await h.cleanup();
  });
  it('records STALE deadline, cancels unsent warnings on reactivation, fences reverse versions, and does not treat BOARD_CLOSED as applied', async () => {
    await handler.handle('moderation:events', lifecycle());
    expect((await items())[0]?.metadata?.scheduledCloseAt).toBeTypeOf('string');
    expect(await store.deliveries(postId)).toHaveLength(1);
    await handler.handle(
      'moderation:events',
      lifecycle('BOARD_REACTIVATED', 2),
    );
    await handler.handle('moderation:events', lifecycle('BOARD_STALE', 1));
    await handler.handle('moderation:events', lifecycle('BOARD_CLOSED', 3));
    expect(await items()).toHaveLength(2);
    expect((await items()).some((n) => n.type === 'POST_CLOSED')).toBe(false);
    await delivery.dispatch(postId);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].data.type).toBe('BOARD_REACTIVATED');
    await store.apply(
      parsePostEvent(wire('PostExpired', { postId, postVersion: 2 }).data)!,
    );
    expect(
      (await items()).filter((n) => n.type === 'POST_CLOSED'),
    ).toHaveLength(1);
    await handler.handle(
      'moderation:events',
      lifecycle('BOARD_REACTIVATED', 4),
    );
    expect(await items()).toHaveLength(3);
  });
  it('does not invent unknown deadlines or authors; late warnings stay inbox-only', async () => {
    await handler.handle(
      'moderation:events',
      fields('BOARD_STALE', {
        aggregateId: postId,
        payload: { postId, state: 'STALE' },
      }),
    );
    expect(await items()).toHaveLength(0);
    await handler.handle(
      'moderation:events',
      lifecycle('BOARD_STALE', 1, new Date(Date.now() - 1000).toISOString()),
    );
    expect(await items()).toHaveLength(1);
    expect(await store.deliveries(postId)).toHaveLength(0);
  });
  it('never emits sanctions from AI flagged or report review-shaped events', async () => {
    await handler.handle(
      'moderation:content-events',
      fields('CONTENT_MODERATION_EVALUATED', {
        postId,
        commentId: 'comment_1',
        flagged: true,
      }),
    );
    const data = {
      reportId: 'report_1',
      reporterUserId: '1',
      targetType: 'POST',
      postId,
      reason: 'SPAM',
    };
    const created = fields('REPORT_CREATED', { data });
    await handler.handle('moderation:report-events', created);
    await handler.handle('moderation:report-events', created);
    await handler.handle(
      'moderation:report-events',
      fields('REPORT_WITHDRAWN', {
        data: { ...data, withdrawnAt: new Date().toISOString() },
      }),
    );
    await handler.handle(
      'moderation:report-events',
      fields('REPORT_REVIEWED', { data }),
    );
    expect((await items()).map((n) => n.type).sort()).toEqual([
      'REPORT_CREATED',
      'REPORT_WITHDRAWN',
    ]);
    expect(await store.deliveries()).toHaveLength(0);
    expect(
      (await h.database.pool.query('SELECT * FROM notification_event_inbox'))
        .rowCount,
    ).toBe(4);
  });
  it.each(['PostDeleted', 'PostCommentDeleted'] as const)(
    'notifies only the actual %s author after confirmed moderation deletion',
    async (type) => {
      const event = parsePostEvent(
        wire(type, { postId, commentId: 'removed', actor: 2, moderation: true })
          .data,
      )!;
      await store.apply(event);
      await store.apply(event);
      const recipient = type === 'PostDeleted' ? '1' : '2';
      expect((await items(recipient))[0]).toMatchObject({
        type: 'CONTENT_REMOVED',
        actionPath: '/notifications',
      });
      expect((await items(recipient))[0]?.body).not.toContain(
        'MODERATION_VIOLATION',
      );
      await delivery.dispatch(postId);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0].userId).toBe(recipient);
    },
  );
  it('cancels all queued activity and stale warnings when Post actually terminates', async () => {
    await handler.handle('moderation:events', lifecycle());
    await store.apply(
      parsePostEvent(wire('PostCommentCreated', { postId }).data)!,
    );
    await store.apply(parsePostEvent(wire('PostExpired', { postId }).data)!);
    expect(
      (await store.deliveries(postId)).map((d) => d.message.data?.type),
    ).toEqual(['POST_CLOSED']);
  });
});
