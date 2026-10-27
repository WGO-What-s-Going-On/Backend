import { expect, it } from 'vitest';
import { redisHarness } from './redis-harness.js';

it('retains the actual Post lifecycle consumer wire contract and keeps content evaluations separate', async () => {
  // Read the consumer's real parser; no dependency on its DB or installed runtime.
  const source = new URL(
    '../../../post-service/src/post/infrastructure/moderation-event.ts',
    import.meta.url,
  );
  const { parseModerationEvent } = await import(/* @vite-ignore */ source.href);
  const h = await redisHarness({
    moderate: async () => ({
      flagged: false,
      categories: {},
      categoryScores: {},
      model: 'fixture',
    }),
  });
  try {
    const postId = h.postId();
    await h.lifecycle.initialize(postId, '2026-01-01T00:00:00.000Z');
    await h.lifecycle.evaluate(postId, new Date('2026-01-01T02:00:00.000Z'));
    await h.lifecycle.evaluate(postId, new Date('2026-01-01T02:10:00.000Z'));
    const messages = await h.redis.xRange('moderation:events', '-', '+');
    expect(
      messages.map((row) => parseModerationEvent(row.message)?.eventType),
    ).toEqual(['BOARD_STALE', 'BOARD_CLOSED']);
    await h.prepare();
    const active = h.postId();
    await h.lifecycle.initialize(active, '2026-01-01T00:00:00.000Z');
    await h.send(
      h.fields('PostCommentCreated', active, '2026-01-01T00:01:00.000Z'),
    );
    const evaluated = (
      await h.redis.xRange('moderation:content-events', '-', '+')
    )[0]!;
    expect(parseModerationEvent(evaluated.message)).toBeNull();
    expect(await h.redis.xLen('moderation:events')).toBe(2);
  } finally {
    await h.cleanup();
  }
});
