import { expect, it } from 'vitest';
import { output, redisHarness } from './redis-harness.js';

it('does not partially create or close a projection when the scan index has the wrong type', async () => {
  const h = await redisHarness({
    moderate: async () => {
      throw new Error('not used');
    },
  });
  try {
    const id = h.postId();
    await h.lifecycle.initialize(id, '2026-01-01T00:00:00.000Z');
    const before = await h.repository.find(id);
    await h.redis.del('moderation:lifecycle:posts');
    await h.redis.set('moderation:lifecycle:posts', 'wrong-type');
    const missing = h.postId();
    await expect(
      h.lifecycle.initialize(missing, '2026-01-01T00:00:00.000Z'),
    ).rejects.toThrow();
    expect(await h.repository.find(missing)).toBeNull();
    await expect(
      h.lifecycle.terminate(
        id,
        'DELETED',
        2,
        '2026-01-01T01:00:00.000Z',
        'req_delete',
      ),
    ).rejects.toThrow();
    expect(await h.repository.find(id)).toEqual(before);
    expect(await h.redis.xLen(output)).toBe(0);
  } finally {
    await h.cleanup();
  }
});

it('does not commit a projection when the output stream has the wrong Redis type', async () => {
  const h = await redisHarness({
    moderate: async () => {
      throw new Error('not used');
    },
  });
  try {
    const id = h.postId();
    await h.lifecycle.initialize(id, '2026-01-01T00:00:00.000Z');
    const before = await h.repository.find(id);
    await h.redis.set(output, 'wrong-type');
    await expect(
      h.lifecycle.evaluate(id, new Date('2026-01-01T02:00:00.000Z')),
    ).rejects.toThrow();
    expect(await h.repository.find(id)).toEqual(before);
  } finally {
    await h.cleanup();
  }
});
