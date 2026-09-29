import { describe, expect, it, vi } from 'vitest';
import { CassandraLocationStore, dayBucket } from '../src/store.js';

describe('Cassandra location history', () => {
  it('writes every request before updating the latest Redis cache', async () => {
    const store = new CassandraLocationStore();
    const execute = vi.fn().mockResolvedValue({ first: () => null });
    const evalCache = vi.fn().mockResolvedValue(1);
    (store.db as any).execute = execute;
    (store.cache as any).eval = evalCache;
    const location = { latitude: 37.5, longitude: 127, updatedAt: new Date() };

    await Promise.all([store.put(123, location), store.put(123, location)]);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      execute.mock.calls.every(([query]) =>
        query.startsWith('INSERT INTO user_location_history'),
      ),
    ).toBe(true);
    expect(execute.mock.calls[0]![1][2].toString()).not.toBe(
      execute.mock.calls[1]![1][2].toString(),
    );
    expect(evalCache).toHaveBeenCalledTimes(2);
    expect(evalCache.mock.invocationCallOrder[0]).toBeGreaterThan(
      execute.mock.invocationCallOrder[0]!,
    );
  });

  it('reads today first and yesterday only when today has no row', async () => {
    const store = new CassandraLocationStore();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ first: () => null })
      .mockResolvedValueOnce({
        first: () => ({
          get: (field: string) =>
            ({ latitude: 37.5, longitude: 127, updated_at: new Date() })[field],
        }),
      });
    (store.db as any).execute = execute;
    (store.cache as any).get = vi.fn().mockResolvedValue(null);
    (store.cache as any).eval = vi.fn().mockResolvedValue(1);

    expect(await store.get(123)).toMatchObject({
      latitude: 37.5,
      longitude: 127,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![1][1]).toBe(dayBucket(new Date()));
    expect(execute.mock.calls[1]![1][1]).toBe(
      dayBucket(new Date(Date.now() - 86400000)),
    );
    expect(execute.mock.calls[0]![0]).toContain('LIMIT 1');
  });

  it('uses a current cache entry and falls back to Cassandra on cache failure', async () => {
    const store = new CassandraLocationStore();
    const execute = vi.fn().mockResolvedValue({ first: () => null });
    const now = new Date();
    const getCache = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          latitude: 37.5,
          longitude: 127,
          updatedAt: now,
          updatedAtMs: now.getTime(),
          ticks: 1,
          updateId: 'id',
        }),
      )
      .mockRejectedValueOnce(new Error('Redis unavailable'));
    (store.db as any).execute = execute;
    (store.cache as any).get = getCache;

    expect(await store.get(123)).toMatchObject({ latitude: 37.5 });
    expect(execute).not.toHaveBeenCalled();
    expect(await store.get(123)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed Cassandra write', async () => {
    const store = new CassandraLocationStore();
    const evalCache = vi.fn();
    (store.db as any).execute = vi
      .fn()
      .mockRejectedValue(new Error('Cassandra unavailable'));
    (store.cache as any).eval = evalCache;

    await expect(
      store.put(123, { latitude: 37.5, longitude: 127, updatedAt: new Date() }),
    ).rejects.toThrow('Cassandra unavailable');
    expect(evalCache).not.toHaveBeenCalled();
  });
});
