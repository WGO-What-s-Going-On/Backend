import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostIndex } from '../src/post-index.js';

const query = { latitude: 37.5, longitude: 127, radiusM: 250, limit: 1 };
const row = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
});

afterEach(() => vi.restoreAllMocks());

describe('Cassandra fallback pagination', () => {
  it('reads every partition page before sorting and applying the API cursor', async () => {
    const index = new PostIndex();
    vi.spyOn(index.redis, 'get').mockResolvedValue(null);
    vi.spyOn(index.redis, 'sendCommand').mockResolvedValue([]);
    const near = 'post_00000000-0000-4000-8000-000000000001';
    const far = 'post_00000000-0000-4000-8000-000000000002';
    let partition: string | undefined;
    const states: Array<string | undefined> = [];
    const execute = vi.spyOn(index.db, 'execute').mockImplementation((async (
      sql: string,
      params: unknown[],
      options: { pageState?: string },
    ) => {
      if (sql.includes('FROM posts_by_cell')) {
        const key = JSON.stringify(params);
        partition ??= key;
        if (key !== partition) {
          expect(options.pageState).toBeUndefined();
          return { rows: [], pageState: null };
        }
        states.push(options.pageState);
        if (!options.pageState)
          return { rows: [row({ post_id: far })], pageState: 'page-2' };
        if (options.pageState === 'page-2')
          return { rows: [], pageState: 'page-3' };
        return {
          rows: [row({ post_id: near }), row({ post_id: far })],
          pageState: null,
        };
      }
      if (sql.includes('FROM post_locations'))
        return {
          first: () =>
            row({
              latitude: params[0] === near ? 37.5 : 37.501,
              longitude: 127,
              expires_at: null,
            }),
        };
      return { first: () => row({ status: 'ACTIVE' }) };
    }) as any);
    const first = await index.nearby(query);
    expect(first.items.map((item) => item.postId)).toEqual([near]);
    expect(first.nextCursor).not.toBeNull();
    const second = await index.nearby({ ...query, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.postId)).toEqual([far]);
    expect(second.nextCursor).toBeNull();
    expect(states).toEqual([
      undefined,
      'page-2',
      'page-3',
      undefined,
      'page-2',
      'page-3',
    ]);
    expect(
      execute.mock.calls.filter(([sql]) => sql.includes('FROM post_locations')),
    ).toHaveLength(4);
  });

  it('propagates a later-page failure instead of returning an incomplete result', async () => {
    const index = new PostIndex();
    vi.spyOn(index.redis, 'get').mockResolvedValue(null);
    vi.spyOn(index.redis, 'sendCommand').mockResolvedValue([]);
    vi.spyOn(index.db, 'execute').mockImplementation((async (
      _sql: string,
      _params: unknown[],
      options: { pageState?: string },
    ) => {
      if (options.pageState) throw new Error('Cassandra next page unavailable');
      return { rows: [], pageState: 'next' };
    }) as any);
    await expect(index.nearby(query)).rejects.toThrow(
      'Cassandra next page unavailable',
    );
  });
});
