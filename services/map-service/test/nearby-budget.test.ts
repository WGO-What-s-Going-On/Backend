import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostIndex } from '../src/post-index.js';
import { NearbyBudget, nearbyLimits } from '../src/nearby-budget.js';
const query = {
  latitude: 37.5,
  longitude: 127,
  radiusM: 250 as const,
  limit: 20,
};
const row = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
});
function fixture(ids?: string[]) {
  const index = new PostIndex();
  vi.spyOn(index.redis, 'withCommandOptions').mockReturnValue(
    index.redis as any,
  );
  vi.spyOn(index.redis, 'eval').mockResolvedValue([ids ? 1 : 0, ids ?? []]);
  return index;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('nearby request budget', () => {
  it('rejects invalid limits at startup', () => {
    vi.stubEnv('MAP_NEARBY_MAX_QUERIES', '0');
    expect(() => new PostIndex()).toThrow('Invalid MAP_NEARBY_MAX_QUERIES');
  });
  it('caps total location/status reads, even with multiple workers', async () => {
    vi.stubEnv('MAP_NEARBY_MAX_QUERIES', '3');
    const index = fixture(['a', 'b', 'c']);
    const execute = vi.spyOn(index.db, 'execute').mockResolvedValue({
      first: () =>
        row({
          latitude: 37.5,
          longitude: 127,
          expires_at: null,
          status: 'ACTIVE',
        }),
    } as any);
    await expect(index.nearby(query)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it('rejects excess GEO candidates before Cassandra access', async () => {
    vi.stubEnv('MAP_NEARBY_MAX_CANDIDATES', '2');
    const index = fixture(['a', 'b', 'c']);
    const execute = vi.spyOn(index.db, 'execute');
    await expect(index.nearby(query)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('charges unique candidates across Cassandra pages and never returns a partial success', async () => {
    vi.stubEnv('MAP_NEARBY_MAX_CANDIDATES', '2');
    const index = fixture();
    const execute = vi.spyOn(index.db, 'execute').mockImplementation((async (
      _sql: string,
      _args: unknown[],
      opts: { pageState?: string },
    ) => {
      return {
        rows: (opts.pageState ? ['c'] : ['a', 'b']).map((id) =>
          row({ post_id: id }),
        ),
        pageState: opts.pageState ? 'third' : 'second',
      };
    }) as any);
    await expect(index.nearby(query)).rejects.toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
    });
    expect(
      execute.mock.calls.some((call) => (call[2] as any).pageState === 'third'),
    ).toBe(false);
  });
  it('applies caller deadline before scheduling any work', async () => {
    const index = fixture();
    const execute = vi.spyOn(index.db, 'execute');
    await expect(
      index.nearby(query, { deadline: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('lets a later shared waiter finish after the first cancels', async () => {
    const index = fixture();
    const held = gate<any>();
    let first = true;
    const execute = vi
      .spyOn(index.db, 'execute')
      .mockImplementation((async () => {
        if (first) {
          first = false;
          return held.promise;
        }
        return { rows: [], pageState: null };
      }) as any);
    const controller = new AbortController();
    const a = index.nearby(query, { signal: controller.signal });
    const rejected = expect(a).rejects.toMatchObject({ code: 'CANCELLED' });
    const b = index.nearby(query);
    await vi.waitFor(() =>
      expect(execute.mock.calls.length).toBeGreaterThan(1),
    );
    controller.abort();
    await rejected;
    held.resolve({ rows: [], pageState: 'next' });
    expect(await b).toEqual({ items: [], nextCursor: null });
  });
  it('does not read another shared page when all waiters cancel', async () => {
    const index = fixture();
    const held = gate<any>();
    const execute = vi
      .spyOn(index.db, 'execute')
      .mockImplementation((async () => held.promise) as any);
    const a = new AbortController(),
      b = new AbortController();
    const waiting = Promise.allSettled([
      index.nearby(query, { signal: a.signal }),
      index.nearby(query, { signal: b.signal }),
    ]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(8));
    a.abort();
    b.abort();
    expect((await waiting).every((r) => r.status === 'rejected')).toBe(true);
    held.resolve({ rows: [], pageState: 'next' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledTimes(8);
  });
  it('ends a hanging dependency wait at the internal deadline', async () => {
    vi.stubEnv('MAP_NEARBY_TIMEOUT_MS', '20');
    const index = fixture(['a']);
    const held = gate<any>();
    const execute = vi
      .spyOn(index.db, 'execute')
      .mockImplementation((async () => held.promise) as any);
    await expect(index.nearby(query)).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    });
    held.resolve({ first: () => row({ latitude: 37.5, longitude: 127 }) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('keeps accounting across multiple phases and avoids duplicate candidate charges', () => {
    const budget = new NearbyBudget({
      ...nearbyLimits(),
      maxQueries: 2,
      maxCandidates: 1,
    });
    try {
      budget.addCandidates(['a', 'a']);
      budget.addCandidates(['a']);
      budget.chargeQuery();
      budget.chargeQuery();
      expect(() => budget.chargeQuery()).toThrow('RESOURCE_EXHAUSTED');
    } finally {
      budget.close();
    }
  });
});
