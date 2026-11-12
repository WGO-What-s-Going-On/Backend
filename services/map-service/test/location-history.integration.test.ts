import cassandra from 'cassandra-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CassandraLocationStore, dayBucket } from '../src/store.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('location history in Cassandra', () => {
  const store = new CassandraLocationStore();
  const userId = Math.floor(Math.random() * 1_000_000_000) + 1;

  beforeAll(async () => store.connect());
  afterAll(async () => store.close());

  it('keeps repeated coordinates as separate rows and reads the newest', async () => {
    const coordinate = {
      latitude: 37.5,
      longitude: 127,
      updatedAt: new Date(),
    };
    await store.put(userId, coordinate);
    await store.put(userId, coordinate);
    const rows = await store.db.execute(
      'SELECT update_id FROM user_location_history WHERE user_id = ? AND day_bucket = ?',
      [cassandra.types.Long.fromNumber(userId), dayBucket(new Date())],
      { prepare: true },
    );
    expect(rows.rowLength).toBe(2);
    expect(await store.get(userId)).toMatchObject({
      latitude: 37.5,
      longitude: 127,
    });
    const cached = JSON.parse(
      (await store.cache.get(`map:location:${userId}`))!,
    );
    expect(cached.latitude).toBe(37.5);
    expect(cached.updateId).toBeTypeOf('string');
  });

  it('does not let a late cache update replace a newer location', async () => {
    const older = cassandra.types.TimeUuid.now();
    const newer = cassandra.types.TimeUuid.now();
    const cacheLatest = (store as any).cacheLatest.bind(store);
    await cacheLatest(
      userId + 2,
      { latitude: 38, longitude: 127, updatedAt: newer.getDate() },
      newer,
      300,
    );
    await cacheLatest(
      userId + 2,
      { latitude: 37, longitude: 127, updatedAt: older.getDate() },
      older,
      300,
    );
    expect(await store.get(userId + 2)).toMatchObject({ latitude: 38 });
  });

  it('persists detection across instances and midnight, then releases after ten seconds', async () => {
    const actor = userId + 5;
    const now = new Date();
    now.setUTCHours(0, 0, 5, 0);
    const clock = vi.spyOn(cassandra.types.TimeUuid, 'now');
    const write = async (age: number, longitude = 127) => {
      clock.mockReturnValue(
        cassandra.types.TimeUuid.fromDate(new Date(now.getTime() - age)),
      );
      return store.put(actor, { latitude: 37.5, longitude, updatedAt: now });
    };
    const other = new CassandraLocationStore();
    await other.connect();
    try {
      await write(20000, 126.999);
      expect((await other.movement(actor))?.reason).toBe('');
      await write(10000);
      expect((await other.movement(actor))?.reason).toBe('USER_MOVING');
      await write(1);
      expect((await other.movement(actor))?.reason).toBe(
        'MOVEMENT_UNCONFIRMED',
      );
      await write(0);
      expect((await other.movement(actor))?.reason).toBe('');
      await write(-10000, 127.001);
      await write(-120000, 127.001);
      expect((await other.movement(actor))?.reason).toBe(
        'MOVEMENT_UNCONFIRMED',
      );
      // A delayed observation cannot clear a newer block.
      await write(0);
      expect((await other.movement(actor))?.reason).toBe(
        'MOVEMENT_UNCONFIRMED',
      );
      await write(-130000, 127.001);
      expect((await other.movement(actor))?.reason).toBe('');
    } finally {
      clock.mockRestore();
      await other.close();
    }
  });

  it('serializes simultaneous first observations without losing the movement state', async () => {
    const actor = userId + 6;
    await Promise.all([
      store.put(actor, {
        latitude: 37.5,
        longitude: 127,
        updatedAt: new Date(),
      }),
      store.put(actor, {
        latitude: 37.5,
        longitude: 127.001,
        updatedAt: new Date(),
      }),
    ]);
    expect((await store.movement(actor))?.reason).toBe('USER_MOVING');
  });

  it('has seven-day default TTL and excludes expired rows', async () => {
    const metadata = await store.db.execute(
      "SELECT default_time_to_live FROM system_schema.tables WHERE keyspace_name = 'wgo_map' AND table_name = 'user_location_history'",
    );
    expect(metadata.first()?.get('default_time_to_live')).toBe(604800);
    const expiringUser = cassandra.types.Long.fromNumber(userId + 1);
    await store.db.execute(
      'INSERT INTO user_location_history (user_id, day_bucket, update_id, latitude, longitude, updated_at) VALUES (?, ?, ?, ?, ?, ?) USING TTL 1',
      [
        expiringUser,
        dayBucket(new Date()),
        cassandra.types.TimeUuid.now(),
        37.5,
        127,
        new Date(),
      ],
      { prepare: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await store.get(userId + 1)).toBeNull();
  });
});
