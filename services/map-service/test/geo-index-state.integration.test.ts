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
import { PostIndex, type PostCreated } from '../src/post-index.js';
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
    vi.spyOn(index.redis, 'eval').mockRejectedValueOnce(
      new Error('Redis unavailable'),
    );
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
