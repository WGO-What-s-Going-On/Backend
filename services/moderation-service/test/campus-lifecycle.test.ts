import { describe, expect, it } from 'vitest';
import {
  evaluateLifecycle,
  type LifecycleProjection,
} from '../src/lifecycle/lifecycle.js';
import { CAMPUS_POLICY } from '../src/lifecycle/campus-events.js';
import { parsePostEvent } from '../src/event-consumer/post-event.js';
const id = 'post_3b16ea1a-4de6-4a2c-85be-56a64ada2031';
const createdAt = '2026-11-24T00:00:00.000Z';
const expiresAt = '2026-12-24T00:00:00.000Z';
const base: LifecycleProjection = {
  postId: id,
  state: 'ACTIVE',
  createdAt,
  lastMeaningfulActivityAt: createdAt,
  staleAt: null,
  version: 0,
  reactionHistoryComplete: true,
};
describe('reserved campus lifecycle', () => {
  it.each([3, 4, 5])(
    'keeps reserved balance %s ACTIVE for 30 days despite ENDED',
    (suffix) => {
      const postId = `post_3b16ea1a-4de6-4a2c-85be-56a64ada203${suffix}`;
      const p = {
        ...base,
        postId,
        lifecyclePolicy: CAMPUS_POLICY,
        expiresAt,
        reactions: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            String(i + 1),
            {
              userId: i + 1,
              type: 'ENDED' as const,
              active: true,
              version: 1,
              createdAt,
            },
          ]),
        ),
      };
      for (const hours of [0, 1, 2, 24, 719.99, 720])
        expect(
          evaluateLifecycle(
            p,
            new Date(Date.parse(createdAt) + hours * 3600000),
          ),
        ).toEqual({ projection: p });
      const value = {
        eventId: 'evt_test',
        eventType: 'PostCreated',
        aggregateId: postId,
        schemaVersion: 1,
        producer: 'post-service',
        correlationId: 'test',
        occurredAt: createdAt,
        post: {
          postId,
          authorId: 1,
          radiusM: 350,
          expiresAt,
          lifecyclePolicy: CAMPUS_POLICY,
        },
      };
      expect(
        parsePostEvent({
          eventId: value.eventId,
          eventType: value.eventType,
          data: JSON.stringify(value),
        })?.post?.lifecyclePolicy,
      ).toBe(CAMPUS_POLICY);
    },
  );
  it.each([1, 2, 24, 719.99, 720])(
    'keeps campaign ACTIVE after %s hours; Post owns expiry',
    (hours) => {
      const p = { ...base, lifecyclePolicy: CAMPUS_POLICY, expiresAt };
      expect(
        evaluateLifecycle(p, new Date(Date.parse(createdAt) + hours * 3600000)),
      ).toEqual({ projection: p });
    },
  );
  it('ignores ENDED only for the two policy-marked identities', () => {
    const now = new Date(Date.parse(createdAt) + 300000);
    const reactions = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        String(i),
        {
          userId: i + 1,
          type: 'ENDED' as const,
          active: true,
          version: 1,
          createdAt: now.toISOString(),
        },
      ]),
    );
    const p = { ...base, reactions, lifecyclePolicy: CAMPUS_POLICY, expiresAt };
    expect(evaluateLifecycle(p, now).projection.state).toBe('ACTIVE');
    expect(
      evaluateLifecycle({ ...p, postId: 'ordinary' }, now).projection
        .staleReason,
    ).toBe('ENDED');
    expect(
      evaluateLifecycle({ ...base, reactions }, now).projection.staleReason,
    ).toBe('ENDED');
  });
  it('preserves normal one-hour protection, inactivity and closure', () => {
    expect(
      evaluateLifecycle(base, new Date(Date.parse(createdAt) + 3599999))
        .projection.state,
    ).toBe('ACTIVE');
    const stale = evaluateLifecycle(
      base,
      new Date(Date.parse(createdAt) + 3600000),
    );
    expect(stale.projection.staleReason).toBe('INACTIVITY');
    expect(
      evaluateLifecycle(
        stale.projection,
        new Date(Date.parse(createdAt) + 4200000),
      ).eventType,
    ).toBe('BOARD_CLOSED');
  });
  it('validates the additive PostCreated policy and rejects scope/expiry forgery', () => {
    const value = {
      eventId: 'evt_test',
      eventType: 'PostCreated',
      aggregateId: id,
      schemaVersion: 1,
      producer: 'post-service',
      correlationId: 'test',
      occurredAt: createdAt,
      post: {
        postId: id,
        authorId: 42,
        radiusM: 350,
        expiresAt,
        lifecyclePolicy: CAMPUS_POLICY,
      },
    };
    const parse = (v: unknown) =>
      parsePostEvent({
        eventId: 'evt_test',
        eventType: 'PostCreated',
        data: JSON.stringify(v),
      });
    expect(parse(value)?.post?.lifecyclePolicy).toBe(CAMPUS_POLICY);
    expect(() =>
      parse({
        ...value,
        aggregateId: 'ordinary',
        post: { ...value.post, postId: 'ordinary' },
      }),
    ).toThrow('campus');
    expect(() =>
      parse({ ...value, post: { ...value.post, expiresAt: createdAt } }),
    ).toThrow('campus');
  });
});
