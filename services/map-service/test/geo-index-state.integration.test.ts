import cassandra from 'cassandra-driver';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { latLngToCell } from 'h3-js';
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  PostIndex,
  POST_GROUP,
  POST_STREAM,
  type PostCreated,
} from '../src/post-index.js';
import { PostConsumer } from '../src/post-consumer.js';
import { GEO_STATE, GEO_DIRTY } from '../src/geo-index-state.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('GEO completeness and shared fallback', () => {
  const keyspace = `wgo_geo_${randomUUID().replaceAll('-', '')}`;
  const admin = new cassandra.Client({
    contactPoints: ['localhost'],
    localDataCenter: 'datacenter1',
  });
  let index: PostIndex;
  let other: PostIndex;
  const query = {
    latitude: 37.5,
    longitude: 127,
    radiusM: 250 as const,
    limit: 20,
  };
  const post = (): PostCreated => ({
    postId: `post_${randomUUID()}`,
    eventId: `evt_${randomUUID()}`,
    authorId: 123,
    latitude: 37.5,
    longitude: 127,
    radiusM: 250,
    category: 'INCIDENT',
    expiresAt: null,
    cell: latLngToCell(37.5, 127, 8),
    shard: 0,
  });
  beforeAll(async () => {
    await admin.connect();
    const schema = readFileSync(
      new URL('../schema.cql', import.meta.url),
      'utf8',
    ).replaceAll('wgo_map', keyspace);
    for (const sql of schema.split(';').filter((s) => s.trim()))
      await admin.execute(sql);
    vi.stubEnv('CASSANDRA_KEYSPACE', keyspace);
    vi.stubEnv('REDIS_URL', 'redis://localhost:6381/12');
    index = new PostIndex();
    other = new PostIndex();
    await index.connect();
    await other.connect();
  }, 30000);
  beforeEach(async () => {
    await index.redis.flushDb();
    for (const table of ['post_locations', 'post_status', 'posts_by_cell'])
      await admin.execute(`TRUNCATE ${keyspace}.${table}`);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (index) {
      await index.redis.flushDb();
      await index.close();
    }
    await other?.close();
    await admin.execute(`DROP KEYSPACE ${keyspace}`);
    await admin.shutdown();
    vi.unstubAllEnvs();
  });

  const cellRows = async (p: PostCreated) =>
    (
      await index.db.execute(
        'SELECT post_id FROM posts_by_cell WHERE cell = ? AND shard = ? AND post_id = ?',
        [p.cell, p.shard, p.postId],
        { prepare: true },
      )
    ).rowLength;
  const expectRemoved = async (p: PostCreated) => {
    expect(await cellRows(p)).toBe(0);
    const key =
      (await index.redis.get('map:posts:geo:active')) ?? 'map:posts:geo:v1';
    expect(await index.redis.geoPos(key, p.postId)).toEqual([null]);
    expect(
      (
        await index.db.execute(
          'SELECT post_id FROM post_locations WHERE post_id = ?',
          [p.postId],
          { prepare: true },
        )
      ).rowLength,
    ).toBe(1);
  };

  it.each(['DELETED', 'EXPIRED'] as const)(
    'cleans Cell and both GEO keys for %s, duplicates and late creation',
    async (status) => {
      const p = post(),
        keep = post();
      await index.redis.set('map:posts:geo:rebuild', 'map:posts:test-staging');
      await index.write(p);
      await index.write(keep);
      const event = { postId: p.postId, status, occurredAt: new Date() };
      await other.transition(event);
      await other.transition(event);
      await index.write(p);
      await expectRemoved(p);
      expect(
        await index.redis.geoPos('map:posts:test-staging', p.postId),
      ).toEqual([null]);
      expect(await cellRows(keep)).toBe(1);
      expect(await index.getStatus(p.postId)).toBe(status);
    },
  );

  it('handles termination before the source location exists', async () => {
    const p = post();
    await other.transition({
      postId: p.postId,
      status: 'DELETED',
      occurredAt: new Date(),
    });
    await index.write(p);
    await expectRemoved(p);
  });

  it.each(['cell', 'geo'] as const)(
    'repairs termination before the concurrent %s write',
    async (stage) => {
      const p = post();
      const original = (
        stage === 'cell' ? index.writeCell : index.writeGeo
      ).bind(index);
      const method = stage === 'cell' ? 'writeCell' : 'writeGeo';
      vi.spyOn(index, method).mockImplementation(async (value) => {
        await other.transition({
          postId: p.postId,
          status: 'EXPIRED',
          occurredAt: new Date(),
        });
        await original(value);
      });
      await index.write(p);
      await expectRemoved(p);
    },
  );

  it('rebuild removes legacy terminal and expired Cell rows while keeping active rows', async () => {
    const terminal = post(),
      expired = post(),
      active = post();
    for (const p of [terminal, expired, active]) await index.write(p);
    await other.transition({
      postId: terminal.postId,
      status: 'DELETED',
      occurredAt: new Date(),
    });
    await index.writeCell(terminal); // Simulate an old version retaining the terminal row.
    await index.db.execute(
      'UPDATE post_locations SET expires_at = ? WHERE post_id = ?',
      [new Date(Date.now() - 1000), expired.postId],
      { prepare: true },
    );
    await index.rebuild();
    await expectRemoved(terminal);
    await expectRemoved(expired);
    expect(await cellRows(active)).toBe(1);
    expect((await index.nearby(query)).items.map((p) => p.postId)).toEqual([
      active.postId,
    ]);
  });

  it('rebuild compensates a terminal event arriving before staging GEO insertion', async () => {
    const p = post();
    await index.write(p);
    const add = index.redis.geoAdd.bind(index.redis);
    let transitioned = false;
    vi.spyOn(index.redis, 'geoAdd').mockImplementation((async (
      ...args: Parameters<typeof add>
    ) => {
      if (!transitioned) {
        transitioned = true;
        await other.transition({
          postId: p.postId,
          status: 'DELETED',
          occurredAt: new Date(),
        });
      }
      return add(...args);
    }) as any);
    await index.rebuild();
    await expectRemoved(p);
    expect(await index.redis.hGet(GEO_STATE, 'ready')).toBe('0');
  });

  it.each(['cell', 'geo'] as const)(
    'keeps Pending on %s cleanup failure and repairs by replay',
    async (stage) => {
      const p = post();
      await index.write(p);
      const consumer = new PostConsumer(index);
      await consumer.initialize();
      const eventId = `evt_${randomUUID()}`;
      await index.redis.xAdd(POST_STREAM, '*', {
        eventId,
        eventType: 'PostDeleted',
        data: JSON.stringify({
          eventId,
          eventType: 'PostDeleted',
          schemaVersion: 1,
          producer: 'post-service',
          aggregateId: p.postId,
          occurredAt: new Date().toISOString(),
        }),
      });
      const batches = (await index.redis.xReadGroup(
        POST_GROUP,
        'cell-cleanup',
        { key: POST_STREAM, id: '>' },
        { COUNT: 1 },
      )) as any;
      const entry = batches[0].messages[0];
      const execute = index.db.execute.bind(index.db),
        evalRedis = index.redis.eval.bind(index.redis);
      const spy =
        stage === 'cell'
          ? vi.spyOn(index.db, 'execute').mockImplementation((async (
              ...args: Parameters<typeof execute>
            ) => {
              if (args[0].startsWith('DELETE FROM posts_by_cell'))
                throw new Error('cell delete unavailable');
              return execute(...args);
            }) as any)
          : vi.spyOn(index.redis, 'eval').mockImplementation((async (
              ...args: Parameters<typeof evalRedis>
            ) => {
              if (String(args[0]).includes("redis.call('ZREM'"))
                throw new Error('geo removal unavailable');
              return evalRedis(...args);
            }) as any);
      await consumer.process(entry);
      expect((await consumer.metrics()).pending).toBe(1);
      expect(await index.redis.sCard(GEO_DIRTY)).toBe(1);
      spy.mockRestore();
      const claimed = await index.redis.xAutoClaim(
        POST_STREAM,
        POST_GROUP,
        'cell-recovery',
        0,
        '0-0',
      );
      await consumer.process(claimed.messages[0]!);
      expect((await consumer.metrics()).pending).toBe(0);
      expect(await index.redis.sCard(GEO_DIRTY)).toBe(0);
      await expectRemoved(p);
    },
  );

  it('shares in-flight partition reads, but repeats a later independent request', async () => {
    const execute = vi.spyOn(index.db, 'execute');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => index.nearby(query)),
    );
    expect(results.every((r) => r.items.length === 0)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(304);
    await index.nearby(query);
    expect(execute).toHaveBeenCalledTimes(608);
  });

  it('trusts an empty completed rebuild across instances without Cassandra reads', async () => {
    await index.rebuild();
    const execute = vi.spyOn(other.db, 'execute');
    expect(await other.nearby(query)).toEqual({ items: [], nextCursor: null });
    expect(execute).not.toHaveBeenCalled();
    const created = post();
    await index.write(created);
    expect((await other.nearby(query)).items.map((p) => p.postId)).toEqual([
      created.postId,
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    await index.transition({
      postId: created.postId,
      status: 'DELETED',
      occurredAt: new Date(),
    });
    execute.mockClear();
    expect((await other.nearby(query)).items).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['member', 'key', 'pointer', 'metadata'])(
    'falls back after %s loss and restores missing candidates',
    async (loss) => {
      const a = post(),
        b = post();
      await index.write(a);
      await index.write(b);
      await index.rebuild();
      const key = (await index.redis.get('map:posts:geo:active'))!;
      if (loss === 'member') await index.redis.zRem(key, a.postId);
      if (loss === 'key') await index.redis.del(key);
      if (loss === 'pointer') await index.redis.del('map:posts:geo:active');
      if (loss === 'metadata') await index.redis.del(GEO_STATE);
      const execute = vi.spyOn(other.db, 'execute');
      const result = await other.nearby(query);
      expect(result.items.map((p) => p.postId).sort()).toEqual(
        [a.postId, b.postId].sort(),
      );
      expect(
        execute.mock.calls.filter(([sql]) =>
          sql.includes('FROM posts_by_cell'),
        ),
      ).toHaveLength(304);
      expect(await index.redis.hGet(GEO_STATE, 'ready')).toBe('0');
    },
  );

  it('keeps failed writes dirty until the same event succeeds', async () => {
    await index.rebuild();
    const created = post();
    const write = vi
      .spyOn(index, 'writeGeo')
      .mockRejectedValueOnce(new Error('redis write failed'));
    await expect(index.write(created)).rejects.toThrow('redis write failed');
    expect(await index.redis.sCard(GEO_DIRTY)).toBe(1);
    expect((await other.nearby(query)).items.map((p) => p.postId)).toEqual([
      created.postId,
    ]);
    write.mockRestore();
    await index.write(created);
    expect(await index.redis.sCard(GEO_DIRTY)).toBe(0);
    const execute = vi.spyOn(other.db, 'execute');
    expect((await other.nearby(query)).items).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not certify a rebuild overlapping a write, and can certify a later quiet rebuild', async () => {
    await index.write(post());
    const created = post();
    const writeCell = index.writeCell.bind(index);
    let inserted = false;
    vi.spyOn(index, 'writeCell').mockImplementation(async (p) => {
      await writeCell(p);
      if (!inserted) {
        inserted = true;
        await other.write(created);
      }
    });
    await index.rebuild();
    expect(await index.redis.hGet(GEO_STATE, 'ready')).toBe('0');
    expect((await index.nearby(query)).items).toHaveLength(2);
    await index.rebuild();
    expect(await index.redis.hGet(GEO_STATE, 'ready')).toBe('1');
  });

  it('retries after a shared fallback failure and falls back on Redis read failure', async () => {
    const execute = vi
      .spyOn(index.db, 'execute')
      .mockRejectedValueOnce(new Error('partition unavailable'));
    const failed = await Promise.allSettled(
      Array.from({ length: 10 }, () => index.nearby(query)),
    );
    expect(failed.every((result) => result.status === 'rejected')).toBe(true);
    execute.mockRestore();
    expect((await index.nearby(query)).items).toEqual([]);
    await index.rebuild();
    vi.spyOn(index.redis, 'withCommandOptions').mockReturnValueOnce({
      eval: async () => {
        throw new Error('Redis unavailable');
      },
    } as any);
    const fallback = vi.spyOn(index.db, 'execute');
    expect((await index.nearby(query)).items).toEqual([]);
    expect(fallback).toHaveBeenCalledTimes(304);
  });

  it('does not certify staging data lost during a rebuild', async () => {
    await index.write(post());
    await index.write(post());
    const add = index.redis.geoAdd.bind(index.redis);
    let added = 0;
    vi.spyOn(index.redis, 'geoAdd').mockImplementation((async (
      ...args: Parameters<typeof add>
    ) => {
      const result = await add(...args);
      if (++added === 2) await index.redis.del(String(args[0]));
      return result;
    }) as any);
    await index.rebuild();
    expect(await index.redis.hGet(GEO_STATE, 'ready')).toBe('0');
    expect((await other.nearby(query)).items).toHaveLength(2);
  });

  it('keeps a failed rebuild uncertified', async () => {
    await index.rebuild();
    const execute = vi
      .spyOn(index.db, 'execute')
      .mockRejectedValueOnce(new Error('scan failed'));
    await expect(index.rebuild()).rejects.toThrow('scan failed');
    execute.mockRestore();
    expect(await index.redis.hGet(GEO_STATE, 'ready')).toBe('0');
    expect(await index.redis.get('map:posts:geo:rebuild')).toBeNull();
    expect((await index.nearby(query)).items).toEqual([]);
  });

  it('does not share a final result across different coordinates, radius or cursor', async () => {
    const a = post(),
      b = { ...post(), latitude: 37.502 };
    await index.write(a);
    await index.write(b);
    const [narrow, wide] = await Promise.all([
      index.nearby({ ...query, radiusM: 150, limit: 1 }),
      index.nearby({ ...query, latitude: 37.5001, radiusM: 350, limit: 1 }),
    ]);
    expect(narrow.items.map((p) => p.postId)).toEqual([a.postId]);
    expect(narrow.nextCursor).toBeNull();
    expect(wide.nextCursor).not.toBeNull();
    const next = await index.nearby({
      ...query,
      latitude: 37.5001,
      radiusM: 350,
      limit: 1,
      cursor: wide.nextCursor!,
    });
    expect(next.items.map((p) => p.postId)).toEqual([b.postId]);
  });
});
