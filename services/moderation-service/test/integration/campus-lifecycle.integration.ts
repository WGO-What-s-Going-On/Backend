import { expect, it } from 'vitest';
import { redisHarness } from './redis-harness.js';
import { CAMPUS_POLICY } from '../../src/lifecycle/campus-events.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
it.each([1, 2, 3, 4, 5, 6])(
  'retains reserved post %s policy, due deadline, ENDED, replay and expiry',
  async (suffix) => {
    const h = await redisHarness({
      moderate: async () => ({
        flagged: false,
        categories: {},
        categoryScores: {},
        model: 'local-test',
      }),
    });
    const id = `post_3b16ea1a-4de6-4a2c-85be-56a64ada203${suffix}`;
    const created =
      suffix === 6 ? '2026-11-27T12:00:00.000Z' : '2026-11-24T00:00:00.000Z';
    const expires =
      suffix === 6 ? '2026-12-24T12:52:53.893Z' : '2026-12-24T00:00:00.000Z';
    const commentAt = new Date(Date.parse(created) + 7200000).toISOString();
    const reactionAt = new Date(Date.parse(created) + 10800000).toISOString();
    try {
      const input = {
        eventId: 'evt_campus',
        eventType: 'PostCreated',
        aggregateId: id,
        producer: 'post-service',
        schemaVersion: 1,
        correlationId: 'req_campus',
        occurredAt: created,
        post: {
          postId: id,
          authorId: suffix === 6 ? 1 : 42,
          radiusM: 350,
          expiresAt: expires,
          lifecyclePolicy: CAMPUS_POLICY,
        },
      };
      const e = parsePostEvent({
        eventId: input.eventId,
        eventType: input.eventType,
        data: JSON.stringify(input),
      })!;
      await h.processor.process(e);
      expect(await h.repository.ready()).toBe(true);
      expect(
        Boolean(await h.redis.sIsMember('moderation:lifecycle:posts', id)),
      ).toBe(true);
      expect(await h.redis.zScore('moderation:lifecycle:due', id)).toBe(
        Date.parse(expires),
      );
      await h.lifecycle.recordComment(
        id,
        'comment_local',
        1,
        false,
        commentAt,
        'req_comment',
      );
      for (let i = 1; i <= 5; i++)
        await h.lifecycle.recordReaction(
          id,
          {
            userId: i,
            type: 'ENDED',
            version: 1,
            active: true,
            createdAt: reactionAt,
          },
          reactionAt,
          'req_ended',
          new Date(reactionAt),
        );
      await h.lifecycle.evaluate(id, new Date('2026-12-23T23:59:59.999Z'));
      await h.processor.process(e);
      expect(await h.repository.find(id)).toMatchObject({
        state: 'ACTIVE',
        lifecyclePolicy: CAMPUS_POLICY,
        expiresAt: expires,
      });
      expect(await h.redis.zScore('moderation:lifecycle:due', id)).toBe(
        Date.parse(expires),
      );
      expect(
        await h.lifecycle.due(new Date('2026-12-23T23:59:59.999Z')),
      ).not.toContain(id);
      await h.lifecycle.terminate(id, 'EXPIRED', 2, expires, 'req_expire');
      expect(await h.repository.ready()).toBe(true);
      expect(
        Boolean(await h.redis.sIsMember('moderation:lifecycle:posts', id)),
      ).toBe(false);
      expect(await h.redis.zScore('moderation:lifecycle:due', id)).toBeNull();
      await h.processor.process(e);
      expect(await h.repository.find(id)).toMatchObject({
        state: 'CLOSED',
        sourceState: 'EXPIRED',
      });
    } finally {
      await h.redis.del(`moderation:lifecycle:${id}`);
      await h.cleanup();
    }
  },
);
