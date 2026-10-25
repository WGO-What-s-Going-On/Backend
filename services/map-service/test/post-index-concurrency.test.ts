import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostIndex } from '../src/post-index.js';

const row = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
});
const query = {
  latitude: 37.5,
  longitude: 127,
  radiusM: 250 as const,
  limit: 20,
};
afterEach(() => vi.restoreAllMocks());

describe('bounded nearby reads', () => {
  it.each([false, true])(
    'bounds Cassandra reads for fallback=%s and keeps results',
    async (fallback) => {
      const index = new PostIndex();
      const ids = Array.from(
        { length: 20 },
        (_, n) => `post_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      );
      vi.spyOn(index.redis, 'get').mockResolvedValue(null);
      vi.spyOn(index.redis, 'eval').mockResolvedValue([
        fallback ? 0 : 1,
        fallback ? [] : ids,
      ]);
      let active = 0;
      let peak = 0;
      vi.spyOn(index.db, 'execute').mockImplementation((async (sql: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        if (sql.includes('FROM posts_by_cell'))
          return {
            rows: ids.map((id) => row({ post_id: id })),
            pageState: null,
          };
        if (sql.includes('FROM post_locations'))
          return {
            first: () =>
              row({ latitude: 37.5, longitude: 127, expires_at: null }),
          };
        return { first: () => row({ status: 'ACTIVE' }) };
      }) as any);
      const result = await index.nearby(query);
      expect(result.items.map((item) => item.postId)).toEqual(ids);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
      expect(active).toBe(0);
    },
  );

  it('stops scheduling on failure and waits for in-flight reads before rejecting', async () => {
    const index = new PostIndex();
    vi.spyOn(index.redis, 'get').mockResolvedValue(null);
    vi.spyOn(index.redis, 'eval').mockResolvedValue([
      1,
      Array.from({ length: 100 }, (_, n) => String(n)),
    ]);
    let active = 0;
    let locations = 0;
    vi.spyOn(index.db, 'execute').mockImplementation((async (
      sql: string,
      params: string[],
    ) => {
      if (sql.includes('FROM post_status'))
        return { first: () => row({ status: 'ACTIVE' }) };
      locations++;
      active++;
      await new Promise((resolve) =>
        setTimeout(resolve, params[0] === '0' ? 1 : 10),
      );
      active--;
      if (params[0] === '0') throw new Error('read failed');
      return {
        first: () => row({ latitude: 37.5, longitude: 127, expires_at: null }),
      };
    }) as any);
    await expect(index.nearby(query)).rejects.toThrow('read failed');
    expect(active).toBe(0);
    expect(locations).toBeLessThanOrEqual(8);
  });
});
