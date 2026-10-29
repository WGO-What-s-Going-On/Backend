import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ReportStore } from '../../src/reports/report.store.js';
import { ReportsService } from '../../src/reports/reports.service.js';
import { ReportTarget } from '../../src/reports/report-target.js';
import { ReportOutboxWorker } from '../../src/reports/report-outbox.worker.js';

const database = `wgo_reports_test_${process.pid}_${Date.now()}`;
const base =
  process.env.MODERATION_TEST_DATABASE_URL ??
  'postgres://wgo:wgo@127.0.0.1:5432/postgres';
const redisUrl =
  process.env.MODERATION_TEST_REDIS_URL ?? 'redis://127.0.0.1:6383/13';
for (const url of [base, redisUrl])
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Report integration tests require local endpoints');
const stream = `moderation:report-test:${randomUUID()}`;
const postId = 'post_123e4567-e89b-42d3-a456-426614174000';
const commentId = 'comment_123e4567-e89b-42d3-a456-426614174000';
const input = {
  targetType: 'POST',
  postId,
  reason: 'SPAM',
  description: 'Private description',
};
const target = { verify: vi.fn(async () => {}) };
describe('PostgreSQL report source/outbox and real Redis Streams', () => {
  const admin = new Pool({ connectionString: base });
  const redis = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false },
  });
  let sql: Pool;
  let store: ReportStore;
  let service: ReportsService;
  let worker: ReportOutboxWorker;
  let other: ReportOutboxWorker;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    sql = new Pool({ connectionString: url.toString() });
    await sql.query(
      await readFile(
        new URL('../../migrations/001-reports.sql', import.meta.url),
        'utf8',
      ),
    );
    const config = new ConfigService({
      reports: { databaseUrl: url.toString(), eventStream: stream },
      redis: { url: redisUrl },
    });
    store = new ReportStore(config);
    service = new ReportsService(store, target as unknown as ReportTarget);
    worker = new ReportOutboxWorker(store, config);
    other = new ReportOutboxWorker(store, config);
    await redis.connect();
  });
  beforeEach(async () => {
    target.verify.mockReset().mockResolvedValue();
    await sql.query(
      'TRUNCATE moderation_reports,moderation_report_outbox RESTART IDENTITY CASCADE',
    );
    await redis.del(stream);
  });
  afterAll(async () => {
    await worker?.onModuleDestroy();
    await other?.onModuleDestroy();
    await store?.onModuleDestroy();
    await sql?.end();
    if (redis.isOpen) {
      await redis.del(stream);
      await redis.quit();
    }
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });
  async function records() {
    return (
      await sql.query(
        'SELECT * FROM moderation_report_outbox ORDER BY sequence',
      )
    ).rows;
  }
  it('creates post/comment reports with immutable retry results and no sensitive data in events', async () => {
    const first = await service.create('100', input);
    expect(first).toMatchObject({ status: 'PENDING', withdrawnAt: null });
    expect(
      await service.create('100', {
        ...input,
        reason: 'OTHER',
        description: 'Changed',
      }),
    ).toEqual(first);
    await service.create('100', { ...input, targetType: 'COMMENT', commentId });
    expect(target.verify).toHaveBeenCalledTimes(2);
    expect(await records()).toHaveLength(2);
    await Promise.all([worker.publishPending(), other.publishPending()]);
    const messages = await redis.xRange(stream, '-', '+');
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      const event = JSON.parse(message.message.data!);
      expect(event).toMatchObject({
        eventId: message.message.eventId,
        eventType: 'REPORT_CREATED',
        schemaVersion: 1,
        producer: 'moderation-service',
        data: { reporterUserId: '100', reason: 'SPAM' },
      });
      expect(JSON.stringify(event)).not.toContain('description');
    }
    expect((await records()).every((row) => row.published_at)).toBe(true);
  });
  it('serializes concurrent create/withdraw retries, preserves original data and enforces ownership', async () => {
    const created = await Promise.all(
      Array.from({ length: 12 }, () => service.create('100', input)),
    );
    expect(new Set(created.map((report) => report.reportId)).size).toBe(1);
    expect(await records()).toHaveLength(1);
    const report = created[0]!;
    await expect(
      service.withdraw('200', report.reportId),
    ).rejects.toMatchObject({ status: 404 });
    const withdrawn = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.withdraw('100', report.reportId),
      ),
    );
    expect(new Set(withdrawn.map((result) => result.withdrawnAt)).size).toBe(1);
    expect(await records()).toHaveLength(2);
    const source = (await sql.query('SELECT document FROM moderation_reports'))
      .rows[0].document;
    expect(source).toMatchObject({
      description: input.description,
      status: 'WITHDRAWN',
      createdAt: report.createdAt,
    });
    await expect(service.create('100', input)).rejects.toMatchObject({
      status: 409,
    });
    await Promise.all([worker.publishPending(), other.publishPending()]);
    await Promise.all([worker.publishPending(), other.publishPending()]);
    const messages = await redis.xRange(stream, '-', '+');
    expect(messages.map((entry) => entry.message.eventType)).toEqual([
      'REPORT_CREATED',
      'REPORT_WITHDRAWN',
    ]);
  });
  it('rejects reviewed withdrawal and invalid targets without creating records', async () => {
    const report = await service.create('100', input);
    await sql.query(
      `UPDATE moderation_reports SET document=jsonb_set(document,'{status}','"REVIEWED"') WHERE report_id=$1`,
      [report.reportId],
    );
    await expect(
      service.withdraw('100', report.reportId),
    ).rejects.toMatchObject({ status: 409 });
    target.verify.mockRejectedValueOnce(
      new (await import('@nestjs/common')).NotFoundException(),
    );
    await expect(service.create('200', input)).rejects.toMatchObject({
      status: 404,
    });
    expect(await records()).toHaveLength(1);
  });
  it('rolls back create and withdrawal if transactional event persistence fails', async () => {
    await sql.query(
      `CREATE FUNCTION fail_report_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$ LANGUAGE plpgsql`,
    );
    const inject = () =>
      sql.query(
        'CREATE TRIGGER fail_report_event BEFORE INSERT ON moderation_report_outbox FOR EACH ROW EXECUTE FUNCTION fail_report_event()',
      );
    const clear = () =>
      sql.query('DROP TRIGGER fail_report_event ON moderation_report_outbox');
    try {
      await inject();
      await expect(service.create('100', input)).rejects.toMatchObject({
        status: 503,
      });
      expect(
        (await sql.query('SELECT * FROM moderation_reports')).rows,
      ).toEqual([]);
      await clear();
      const report = await service.create('100', input);
      await inject();
      await expect(
        service.withdraw('100', report.reportId),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        (await sql.query('SELECT document FROM moderation_reports')).rows[0]
          .document.status,
      ).toBe('PENDING');
      expect(await records()).toHaveLength(1);
      await clear();
    } finally {
      await sql.query(
        'DROP TRIGGER IF EXISTS fail_report_event ON moderation_report_outbox',
      );
      await sql.query('DROP FUNCTION fail_report_event()');
    }
  });
  it('retains pending events on Redis failure and recovers with the original eventId', async () => {
    const report = await service.create('100', input);
    const initial = (await records())[0];
    await redis.set(stream, 'wrong type');
    await worker.publishPending();
    expect((await records())[0]).toMatchObject({
      published_at: null,
      attempts: 1,
      event_id: initial.event_id,
    });
    await service.withdraw('100', report.reportId);
    await redis.del(stream);
    await worker.publishPending();
    await other.publishPending();
    const messages = await redis.xRange(stream, '-', '+');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.message.eventId).toBe(initial.event_id);
  });
  it('replays the same eventId after XADD succeeded but database acknowledgement failed', async () => {
    await service.create('100', input);
    await sql.query(
      `CREATE FUNCTION fail_report_ack() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected commit path'; END; $$ LANGUAGE plpgsql`,
    );
    await sql.query(
      'CREATE TRIGGER fail_report_ack BEFORE UPDATE ON moderation_report_outbox FOR EACH ROW EXECUTE FUNCTION fail_report_ack()',
    );
    try {
      await worker.publishPending();
      expect((await records())[0].published_at).toBeNull();
    } finally {
      await sql.query(
        'DROP TRIGGER fail_report_ack ON moderation_report_outbox',
      );
      await sql.query('DROP FUNCTION fail_report_ack()');
    }
    await worker.publishPending();
    const messages = await redis.xRange(stream, '-', '+');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.message.eventId).toBe(messages[1]!.message.eventId);
  });
});
