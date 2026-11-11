import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisHarness, group, stream } from './redis-harness.js';

const verdict = {
  flagged: true,
  categories: { violence: true },
  categoryScores: { violence: 0.9 },
  model: 'fixture',
};
const output = 'moderation:content-events';
describe('post content publication with real Redis', () => {
  let h: Awaited<ReturnType<typeof redisHarness>>;
  const moderate = vi.fn();
  beforeEach(async () => {
    moderate.mockReset().mockResolvedValue(verdict);
    h = await redisHarness({ moderate });
  });
  afterEach(async () => {
    if (h?.redis.isOpen) await h.cleanup();
  });
  function source(
    type: 'PostCreated' | 'PostUpdated',
    postId: string,
    postVersion: number,
  ) {
    return h.fields(type, postId, '2026-11-09T00:00:00.000Z', '', {
      post: {
        postId,
        authorId: 1,
        title: `Private title ${postVersion}`,
        content: `Private body ${postVersion}`,
        closedAt: null,
      },
      postVersion,
    });
  }
  function input(fields: ReturnType<typeof source>) {
    const event = JSON.parse(fields.data);
    return {
      targetType: 'POST' as const,
      eventId: fields.eventId,
      postId: event.aggregateId,
      title: event.post.title as string,
      content: event.post.content as string,
      postVersion: event.postVersion as number,
      authorId: 1,
      correlationId: event.correlationId as string,
    };
  }
  it('publishes creation and out-of-order edits once without changing lifecycle activity', async () => {
    await h.prepare();
    const postId = h.postId();
    const created = source('PostCreated', postId, 1);
    await h.send(created);
    const lifecycle = await h.repository.find(postId);
    const newest = source('PostUpdated', postId, 3);
    await h.send(newest);
    await h.send(source('PostUpdated', postId, 2));
    await h.send(newest);
    const records = await h.redis.xRange(output, '-', '+');
    expect(
      records.map((row) => JSON.parse(row.message.data!).postVersion),
    ).toEqual([1, 3, 2]);
    expect(moderate.mock.calls.map(([content]) => content)).toEqual([
      'Private title 1\n\nPrivate body 1',
      'Private title 3\n\nPrivate body 3',
      'Private title 2\n\nPrivate body 2',
    ]);
    for (const row of records) {
      const event = JSON.parse(row.message.data!);
      expect(event).toMatchObject({
        targetType: 'POST',
        flagged: true,
        postId,
        authorId: 1,
      });
      for (const key of ['title', 'content', 'commentId', 'activityVersion'])
        expect(event).not.toHaveProperty(key);
      expect(row.message.data).not.toContain('Private');
    }
    expect(await h.repository.find(postId)).toEqual(lifecycle);
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
    expect(await h.redis.xLen('moderation:events')).toBe(0);
  });
  it('reuses the prepared POST result after publication failure and republishes exact original output', async () => {
    const value = input(source('PostCreated', h.postId(), 1));
    await h.redis.xAdd(output, '18446744073709551615-18446744073709551615', {
      sentinel: 'owned',
    });
    await expect(h.moderation.moderate(value)).rejects.toThrow(
      'CONTENT_PUBLICATION_FAILED',
    );
    const retained = await h.results.find(value.eventId);
    expect(retained).toMatchObject({ targetType: 'POST', postVersion: 1 });
    await h.redis.del(output);
    expect(await h.moderation.moderate(value, new Date('2099-01-01'))).toEqual(
      retained,
    );
    expect(moderate).toHaveBeenCalledOnce();
    await h.results.republish(value.eventId);
    const records = await h.redis.xRange(output, '-', '+');
    expect(records).toHaveLength(2);
    expect(records[0]!.message).toEqual(records[1]!.message);
  });
  it.each(['POST', 'COMMENT'] as const)(
    'repairs a %s publication using canonical identity instead of the competing input',
    async (targetType) => {
      const fields = source('PostCreated', h.postId(), 3);
      const base = {
        ...verdict,
        eventId: fields.eventId,
        postId: input(fields).postId,
        moderatedAt: '2026-01-01T00:00:00.000Z',
      };
      const canonical =
        targetType === 'POST'
          ? { ...base, targetType: 'POST' as const, postVersion: 3 }
          : { ...base, commentId: 'comment_legacy', activityVersion: 7 };
      await h.redis.set(
        `moderation:content:${fields.eventId}`,
        JSON.stringify(canonical),
      );
      await h.results.save(
        targetType === 'POST'
          ? { ...base, commentId: 'wrong_comment', activityVersion: 99 }
          : { ...base, targetType: 'POST', postVersion: 99 },
      );
      const event = JSON.parse(
        (await h.redis.xRange(output, '-', '+'))[0]!.message.data!,
      );
      expect(event.targetType).toBe(targetType);
      expect(event.evaluatedAt).toBe(base.moderatedAt);
      if (targetType === 'POST') {
        expect(event.postVersion).toBe(3);
        expect(event).not.toHaveProperty('commentId');
        expect(event).not.toHaveProperty('activityVersion');
      } else {
        expect(event.commentId).toBe('comment_legacy');
        expect(event.activityVersion).toBe(7);
        expect(event).not.toHaveProperty('postVersion');
      }
      expect(moderate).not.toHaveBeenCalled();
    },
  );
});
