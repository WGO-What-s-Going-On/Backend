import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostIndex, type PostCreated } from '../src/post-index.js';
const post: PostCreated = {
  postId: 'post_00000000-0000-4000-8000-000000000001',
  eventId: 'evt_00000000-0000-4000-8000-000000000001',
  authorId: 123,
  latitude: 37.5,
  longitude: 127,
  radiusM: 250,
  category: 'INCIDENT',
  expiresAt: null,
  cell: '8830e1d8abfffff',
  shard: 0,
};
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const index = new PostIndex();
  vi.spyOn(index.redis, 'eval').mockResolvedValue(1);
  vi.spyOn(index.redis, 'sRem').mockResolvedValue(1);
  const execute = vi.spyOn(index.db, 'execute').mockResolvedValue({
    first: () => ({
      get: (key: string) =>
        (({ cell: post.cell, shard: post.shard }) as Record<string, unknown>)[
          key
        ],
    }),
  } as any);
  return { index, execute };
}
describe('terminated Cell cleanup', () => {
  it.each(['DELETED', 'EXPIRED'] as const)(
    'deletes the exact Cell row after %s',
    async (status) => {
      const { index, execute } = fixture();
      await index.transition({
        postId: post.postId,
        status,
        occurredAt: new Date(),
      });
      expect(
        execute.mock.calls.some(
          ([sql, params]) =>
            sql.startsWith('DELETE FROM posts_by_cell') &&
            JSON.stringify(params) ===
              JSON.stringify([post.cell, post.shard, post.postId]),
        ),
      ).toBe(true);
    },
  );
  it('does not insert Cell/GEO for a late creation after termination', async () => {
    const { index, execute } = fixture();
    vi.spyOn(index, 'getStatus').mockResolvedValue('DELETED');
    const cell = vi.spyOn(index, 'writeCell'),
      geo = vi.spyOn(index, 'writeGeo');
    await index.write(post);
    expect(cell).not.toHaveBeenCalled();
    expect(geo).not.toHaveBeenCalled();
    expect(
      execute.mock.calls.some(([sql]) =>
        sql.startsWith('DELETE FROM posts_by_cell'),
      ),
    ).toBe(true);
  });
  it('repairs a terminal transition that interleaves with spatial publication', async () => {
    const { index, execute } = fixture();
    vi.spyOn(index, 'getStatus')
      .mockResolvedValueOnce('ACTIVE')
      .mockResolvedValue('EXPIRED');
    await index.write(post);
    expect(
      execute.mock.calls.some(([sql]) =>
        sql.startsWith('DELETE FROM posts_by_cell'),
      ),
    ).toBe(true);
  });
});
