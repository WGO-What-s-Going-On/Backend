import { expect, it } from 'vitest';
import { output, redisHarness } from './redis-harness.js';

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
