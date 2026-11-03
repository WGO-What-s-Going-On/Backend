import { expect, it } from 'vitest';
import { harness } from './harness.js';
import { migrate } from '../../src/persistence/schema.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
import { wire } from '../helpers/post-events.js';

it('upgrades a populated v1 layout while preserving read state, tokens, preferences, event markers and pending deliveries', async () => {
  const h = await harness();
  h.ownedKeys.add('notification:unread:1');
  try {
    const event = parsePostEvent(wire('PostCommentCreated').data)!,
      store = new PostgresEventStore(h.database);
    await store.apply(event);
    const old = (await h.notifications.list('1')).items[0]!;
    await h.notifications.markRead('1', old.notificationId);
    await h.subscriptions.upsert('1', 'legacy-test-token', 'web');
    await store.savePreferences('1', { replies: false });
    // Reconstruct the exact v1 columns/PK in this UUID test schema only. The
    // stored business rows remain in place while the production migration runs.
    await h.database.transaction(async (c) => {
      await c.query(`DROP TABLE notification_nearby_jobs,notification_nearby_subscriptions,notification_nearby_limits,
    notification_comment_states,notification_lifecycle_states,notification_event_inbox,notification_stream_starts,notification_business_keys;
    ALTER TABLE notification_activities DROP COLUMN details;
    ALTER TABLE notification_posts DROP COLUMN paused;
    DROP TRIGGER notification_delivery_scope ON notification_deliveries;
    DROP FUNCTION notification_delivery_scope();
    ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_pkey;
    ALTER TABLE notification_deliveries DROP COLUMN scope_id;
    ALTER TABLE notification_deliveries ALTER COLUMN post_id SET NOT NULL;
    ALTER TABLE notification_deliveries ADD PRIMARY KEY(post_id,key);
    DELETE FROM notification_schema_versions WHERE version>1;`);
    });
    await migrate(h.database.pool);
    await migrate(h.database.pool);
    const current = (await h.notifications.list('1')).items[0]!;
    expect(current).toMatchObject({ ...old, isRead: true });
    expect(await h.notifications.unread('1')).toBe(0);
    expect((await h.subscriptions.list('1'))[0]?.token).toBe(
      'legacy-test-token',
    );
    expect((await store.preferences('1')).replies).toBe(false);
    expect((await store.deliveries())[0]).toMatchObject({
      postId: event.aggregateId,
      scopeId: `post:${event.aggregateId}`,
      status: 'PENDING',
    });
    await store.apply(event);
    expect((await h.notifications.list('1')).items).toHaveLength(1);
    expect(
      (await h.database.pool.query('SELECT * FROM notification_event_inbox'))
        .rowCount,
    ).toBe(1);
  } finally {
    await h.cleanup();
  }
});
