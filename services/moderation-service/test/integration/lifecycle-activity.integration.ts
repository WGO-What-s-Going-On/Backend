import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { ReactionType } from '../../src/lifecycle/lifecycle.js';
import { LifecycleService } from '../../src/lifecycle/lifecycle.service.js';
import { RedisLifecycleRepository } from '../../src/lifecycle/redis-lifecycle.repository.js';
import { group, stream, output, redisHarness, dead } from './redis-harness.js';

const at = (m: number) =>
  new Date(Date.UTC(2026, 0, 1) + m * 60_000).toISOString();
const result = {
  flagged: false,
  categories: {},
  categoryScores: {},
  model: 'omni-moderation-latest',
};
describe('versioned activity and frozen ENDED evidence with Redis', () => {
  let h: Awaited<ReturnType<typeof redisHarness>>;
  let minutes: number;
  const moderate = vi.fn();
  beforeEach(async () => {
    minutes = 10;
    moderate.mockReset().mockResolvedValue(result);
    h = await redisHarness({ moderate }, { now: () => new Date(at(minutes)) });
    await h.prepare();
  });
  afterEach(async () => {
    if (h?.redis.isOpen) await h.cleanup();
  });
  const projection = (id: string) => h.repository.find(id);
  async function create() {
    const id = h.postId();
    await h.send(h.fields('PostCreated', id, at(0)));
    return id;
  }
  async function reaction(
    id: string,
    userId: number,
    type: ReactionType = 'ENDED',
    version = 1,
    active = true,
    created = 9,
    occurred = minutes,
  ) {
    const message = h.fields(
      active ? 'PostReactionCreated' : 'PostReactionRemoved',
      id,
      at(occurred),
      '',
      {
        activityVersion: version,
        reaction: {
          postId: id,
          userId,
          type,
          createdAt: at(created),
          ...(!active ? { removedAt: at(occurred) } : {}),
        },
      },
    );
    await h.send(message);
    return message;
  }
  async function seed(id: string, ended = 5, other = 0) {
    for (let i = 1; i <= other; i++) await reaction(id, 100 + i, 'CURIOUS');
    for (let i = 1; i <= ended; i++) await reaction(id, i);
  }
  async function events() {
    return (await h.redis.xRange(output, '-', '+')).map(
      (e) => JSON.parse(e.message.data!).eventType,
    );
  }
  async function state(id: string, expected: string) {
    expect((await projection(id))?.state).toBe(expected);
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
    expect(await h.redis.xLen(dead)).toBe(0);
  }
  it('does not enter early STALE with four ENDED users or five of eight users', async () => {
    const four = await create();
    await seed(four, 4);
    await state(four, 'ACTIVE');
    const minority = await create();
    await seed(minority, 5, 3);
    await state(minority, 'ACTIVE');
  });
  it('enters before one hour at exactly 7/10 and saves voter/version evidence', async () => {
    const id = await create();
    await seed(id, 7, 3);
    await state(id, 'STALE');
    const p = await projection(id);
    expect(p).toMatchObject({
      staleReason: 'ENDED',
      staleAt: at(10),
      endedSnapshot: {
        windowStart: at(0),
        endedCount: 7,
        recentReactionUserCount: 10,
        ratio: 0.7,
        certain: true,
        minimumEnded: 5,
        minimumRatio: 0.7,
      },
    });
    expect(p!.endedSnapshot!.voters).toHaveLength(10);
    expect(p!.endedSnapshot!.voters[0]).toMatchObject({
      version: 1,
      active: true,
    });
    expect(await events()).toEqual(['BOARD_STALE']);
  });
  it('keeps the window frozen for ten minutes and closes once after repository reconnect', async () => {
    const id = await create();
    await seed(id);
    const snapshot = (await projection(id))!.endedSnapshot;
    minutes = 19;
    await h.lifecycle.evaluate(id, new Date(at(minutes)));
    await state(id, 'STALE');
    await h.repository.onModuleDestroy();
    const repository = new RedisLifecycleRepository(
      new ConfigService({
        redis: {
          url:
            process.env.MODERATION_TEST_REDIS_URL ??
            'redis://localhost:6383/15',
        },
      }),
    );
    try {
      const restarted = new LifecycleService(repository);
      minutes = 20;
      await Promise.all([
        restarted.evaluate(id, new Date(at(minutes))),
        restarted.evaluate(id, new Date(at(minutes))),
      ]);
      expect(await repository.find(id)).toMatchObject({
        state: 'CLOSED',
        endedSnapshot: snapshot,
        endedAssessment: {
          endedCount: 5,
          recentReactionUserCount: 5,
          windowStart: at(0),
        },
      });
      expect((await restarted.list()).map((p) => p.postId)).not.toContain(id);
      await restarted.recordActivity(id, at(21), 'req_late');
      expect((await repository.find(id))?.state).toBe('CLOSED');
      expect(await events()).toEqual(['BOARD_STALE', 'BOARD_CLOSED']);
    } finally {
      await repository.onModuleDestroy();
    }
  });
  it('reactivates on cancellation, rejects reversed v1, and permits a new v3 registration', async () => {
    const id = await create();
    await seed(id);
    minutes = 11;
    const removed = await reaction(id, 1, 'ENDED', 2, false);
    await state(id, 'ACTIVE');
    await h.send(removed);
    await reaction(id, 1, 'ENDED', 1);
    expect((await projection(id))!.reactions!['1:ENDED']).toMatchObject({
      active: false,
      version: 2,
    });
    expect(await events()).toEqual(['BOARD_STALE', 'BOARD_REACTIVATED']);
    await reaction(id, 1, 'ENDED', 3, true, 11);
    await state(id, 'STALE');
    expect((await projection(id))!.endedSnapshot!.endedCount).toBe(5);
  });
  it('records removal before creation and counts a new version only once', async () => {
    const id = await create();
    await seed(id, 4);
    await reaction(id, 5, 'ENDED', 2, false);
    await reaction(id, 5, 'ENDED', 1);
    await state(id, 'ACTIVE');
    const created = await reaction(id, 5, 'ENDED', 3);
    const before = await projection(id);
    await h.send(created);
    await reaction(id, 5, 'ENDED', 3);
    expect(await projection(id)).toEqual(before);
    await state(id, 'STALE');
    expect(before!.endedSnapshot!.endedCount).toBe(5);
  });
  it('applies new ENDED and later cancellation without changing the entry snapshot or resetting grace', async () => {
    const id = await create();
    await seed(id);
    const snapshot = (await projection(id))!.endedSnapshot;
    minutes = 19;
    await reaction(id, 6, 'ENDED', 1, true, 19);
    await reaction(id, 1, 'ENDED', 2, false);
    expect(await projection(id)).toMatchObject({
      state: 'STALE',
      staleAt: at(10),
      endedSnapshot: snapshot,
    });
    await h.lifecycle.evaluate(id, new Date(at(19.999)));
    await state(id, 'STALE');
    await h.lifecycle.evaluate(id, new Date(at(20)));
    await state(id, 'CLOSED');
    expect(
      (await projection(id))!
        .endedAssessment!.voters.map((r) => r.userId)
        .sort(),
    ).toEqual([2, 3, 4, 5, 6]);
  });
  it('returns ACTIVE instead of closing when cancellation arrives at the grace boundary', async () => {
    const id = await create();
    await seed(id);
    minutes = 20;
    await reaction(id, 1, 'ENDED', 2, false);
    await h.lifecycle.evaluate(id, new Date(at(20)));
    await state(id, 'ACTIVE');
    expect(await events()).toEqual(['BOARD_STALE', 'BOARD_REACTIVATED']);
  });
  it('keeps legacy projections conservative until ten minutes of new reaction history is observed', async () => {
    const id = h.postId();
    await h.redis.set(
      `moderation:lifecycle:${id}`,
      JSON.stringify({
        postId: id,
        state: 'ACTIVE',
        createdAt: at(0),
        lastMeaningfulActivityAt: at(0),
        staleAt: null,
        version: 0,
      }),
    );
    await seed(id);
    await state(id, 'ACTIVE');
    // 과거에 무시한 공감을 현재 이력 전체로 간주하지 않는다. 새 window부터 다시 판단한다.
    minutes = 20;
    for (let i = 1; i <= 5; i++) await reaction(id, i, 'ENDED', 3, true, 20);
    await state(id, 'STALE');
  });
  it.each(['CURIOUS', 'STILL_HAPPENING', 'HELPFUL'] as const)(
    'reactivates on new %s while new ENDED is non-meaningful',
    async (type) => {
      const id = await create();
      await seed(id);
      const snapshot = (await projection(id))!.endedSnapshot;
      minutes = 11;
      await reaction(id, 6, 'ENDED', 1, true, 11);
      expect(await projection(id)).toMatchObject({
        state: 'STALE',
        lastMeaningfulActivityAt: at(0),
        endedSnapshot: snapshot,
      });
      minutes = 12;
      await reaction(id, 7, type, 1, true, 12);
      expect(await projection(id)).toMatchObject({
        state: 'ACTIVE',
        staleAt: null,
        lastMeaningfulActivityAt: at(12),
      });
      expect((await projection(id))!.endedSnapshot).toBeUndefined();
    },
  );
  it('does not compare cross-kind versions and blocks closure while active relations conflict', async () => {
    const id = await create();
    await reaction(id, 1, 'ENDED', 3);
    // 종류가 다른 v3와 v1은 순서를 결정하는 데 사용할 수 없다.
    await reaction(id, 1, 'CURIOUS', 1, true, 8, 8);
    await seed(id);
    await state(id, 'ACTIVE');
    expect((await projection(id))!.reactions!['1:ENDED']!.version).toBe(3);
    await reaction(id, 1, 'CURIOUS', 2, false, 8);
    await state(id, 'STALE');
  });
  it('handles ENDED-to-CURIOUS and never moves activity time backward', async () => {
    const id = await create();
    await seed(id);
    minutes = 11;
    await reaction(id, 1, 'ENDED', 2, false);
    await reaction(id, 1, 'CURIOUS', 1, true, 11);
    await reaction(id, 2, 'HELPFUL', 1, true, 8, 8);
    expect(await projection(id)).toMatchObject({
      state: 'ACTIVE',
      lastMeaningfulActivityAt: at(11),
    });
  });
  it('uses an open lower boundary, closed upper boundary, and excludes future creations', async () => {
    const id = await create();
    for (let i = 1; i <= 5; i++) await reaction(id, i, 'ENDED', 1, true, 0, 0);
    await state(id, 'ACTIVE');
    for (let i = 1; i <= 5; i++) await reaction(id, i, 'ENDED', 3, true, 10);
    await state(id, 'STALE');
    const future = await create();
    for (let i = 1; i <= 5; i++)
      await reaction(future, i, 'ENDED', 1, true, 11, 11);
    await state(future, 'ACTIVE');
  });
  it('does not reactivate from a meaningful event that occurred before staleAt', async () => {
    const id = await create();
    await seed(id);
    minutes = 11;
    await reaction(id, 8, 'CURIOUS', 1, true, 9, 9);
    await state(id, 'STALE');
    await h.lifecycle.evaluate(id, new Date(at(20)));
    await state(id, 'CLOSED');
  });
  it('reactivates on a comment without rolling historical activity back on deletion', async () => {
    const id = await create();
    await seed(id);
    minutes = 11;
    const created = h.fields('PostCommentCreated', id, at(11));
    const comment = JSON.parse(created.data).comment;
    await h.send(created);
    await state(id, 'ACTIVE');
    const deleted = h.fields('PostCommentDeleted', id, at(12), '', {
      comment: { ...comment, deletedAt: at(12) },
      activityVersion: 2,
    });
    await h.send(deleted);
    await h.send(deleted);
    expect(await projection(id)).toMatchObject({
      lastMeaningfulActivityAt: at(11),
      comments: { [comment.commentId]: { deleted: true, version: 2 } },
    });
    await h.send(
      h.fields('PostCommentCreated', id, at(11), '', {
        comment,
        activityVersion: 1,
      }),
    );
    expect(moderate).toHaveBeenCalledOnce();
  });
  it('skips AI when deletion arrives before creation', async () => {
    const id = await create();
    await h.send(h.fields('PostCommentDeleted', id, at(11)));
    await h.send(
      h.fields('PostCommentCreated', id, at(10), 'late', {
        comment: {
          commentId: 'comment_deleted',
          postId: id,
          authorId: 1,
          content: 'late',
        },
      }),
    );
    expect(moderate).not.toHaveBeenCalled();
    expect(await projection(id)).toMatchObject({
      lastMeaningfulActivityAt: at(0),
    });
  });
  it('keeps AI evidence but suppresses activity when deletion wins during the API request', async () => {
    const id = await create();
    await seed(id);
    const created = h.fields('PostCommentCreated', id, at(11));
    const comment = JSON.parse(created.data).comment;
    moderate.mockImplementationOnce(async () => {
      await h.processor.process(
        JSON.parse(
          h.fields('PostCommentDeleted', id, at(12), '', {
            comment: { ...comment, deletedAt: at(12) },
          }).data,
        ),
      );
      return result;
    });
    await h.send(created);
    await state(id, 'STALE');
    expect(await h.results.find(created.eventId)).toMatchObject(result);
    expect((await projection(id))!.comments![comment.commentId]!.deleted).toBe(
      true,
    );
  });
  it.each(['PostDeleted', 'PostExpired'] as const)(
    'keeps %s terminal before or after creation',
    async (type) => {
      for (const createdFirst of [true, false]) {
        const id = createdFirst ? await create() : h.postId();
        if (createdFirst) await seed(id);
        const terminal = h.fields(type, id, at(11));
        await h.send(terminal);
        await h.send(terminal);
        await h.send(h.fields('PostCreated', id, at(0)));
        await reaction(id, 8, 'CURIOUS', 1, true, 12, 12);
        await h.send(h.fields('PostCommentCreated', id, at(12)));
        await state(id, 'CLOSED');
        expect((await h.lifecycle.list()).map((p) => p.postId)).not.toContain(
          id,
        );
        expect((await projection(id))!.reactions).toBeUndefined();
      }
      expect(await events()).not.toContain('BOARD_CLOSED');
      expect(moderate).not.toHaveBeenCalled();
    },
  );
  it('retains concurrent unique users with CAS and emits only one early transition', async () => {
    const id = await create();
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        h.lifecycle.recordReaction(
          id,
          {
            userId: i + 1,
            type: 'ENDED',
            version: 1,
            active: true,
            createdAt: at(9),
          },
          at(10),
          'req_concurrent',
          new Date(at(10)),
        ),
      ),
    );
    expect(Object.values((await projection(id))!.reactions!)).toHaveLength(7);
    expect(await events()).toEqual(['BOARD_STALE']);
  });
});
