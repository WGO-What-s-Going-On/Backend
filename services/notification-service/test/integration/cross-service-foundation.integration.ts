import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postgresHarness } from './postgres-harness.js';
import { NotificationEventWriter } from '../../src/persistence/notification-event.writer.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { migrate } from '../../src/persistence/schema.js';
describe('cross-service PostgreSQL receipts and delivery scopes', () => {
  let h: Awaited<ReturnType<typeof postgresHarness>>,
    writer: NotificationEventWriter;
  beforeEach(async () => {
    h = await postgresHarness();
    writer = new NotificationEventWriter(h.database);
  });
  afterEach(async () => {
    await h?.cleanup();
  });
  async function record(stream: string) {
    return writer.record(stream, 'same-id', { type: 'test' }, async (c) => {
      await writer.write(c, {
        stream,
        businessKey: 'fact',
        eventId: 'same-id',
        userId: '42',
        type: stream === 'user:events' ? 'BADGE_GRANTED' : 'REPORT_CREATED',
        title: '알림',
        body: '확인된 사실',
        category: 'rewards',
        push: true,
      });
      return ['42'];
    });
  }
  it('isolates matching IDs from different streams, without inventing post rows', async () => {
    await Promise.all([record('user:events'), record('user:events')]);
    await record('moderation:report-events');
    expect(
      (await h.database.pool.query('SELECT count(*) FROM notifications'))
        .rows[0].count,
    ).toBe('2');
    expect(
      (
        await h.database.pool.query(
          'SELECT count(*) FROM notification_event_inbox',
        )
      ).rows[0].count,
    ).toBe('2');
    expect(
      (await h.database.pool.query('SELECT * FROM notification_posts')).rows,
    ).toEqual([]);
    const store = new PostgresEventStore(h.database),
      jobs = await store.deliveries();
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.postId === null)).toBe(true);
    const leased = await store.acquire(jobs[0]!);
    expect(leased?.status).toBe('SENDING');
    await store.finish(leased!, 'SENT');
  });
  it('rolls back inbox, notification and delivery together on commit failure, then retries', async () => {
    await h.database.pool
      .query(`CREATE FUNCTION fail_event_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE CONSTRAINT TRIGGER fail_event_commit AFTER INSERT ON notification_event_inbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_event_commit()`);
    await expect(record('user:events')).rejects.toThrow('injected');
    for (const table of [
      'notification_event_inbox',
      'notifications',
      'notification_deliveries',
    ])
      expect(
        (await h.database.pool.query(`SELECT * FROM ${table}`)).rows,
      ).toEqual([]);
    await h.database.pool.query(
      'DROP TRIGGER fail_event_commit ON notification_event_inbox;DROP FUNCTION fail_event_commit()',
    );
    await record('user:events');
    expect(
      (await h.database.pool.query('SELECT count(*) FROM notifications'))
        .rows[0].count,
    ).toBe('1');
  });
  it('keeps normal suppressed events in the inbox and preserves existing rows across migration retries', async () => {
    await writer.record(
      'user:events',
      'credit',
      { type: 'USER_CREDIT_CHANGED' },
      async () => [],
    );
    const work = vi.fn(async () => []);
    await writer.record('user:events', 'credit', {}, work);
    expect(work).not.toHaveBeenCalled();
    const before = (
      await h.database.pool.query('SELECT * FROM notification_event_inbox')
    ).rows;
    await migrate(h.database.pool);
    expect(
      (await h.database.pool.query('SELECT * FROM notification_event_inbox'))
        .rows,
    ).toEqual(before);
  });
});
