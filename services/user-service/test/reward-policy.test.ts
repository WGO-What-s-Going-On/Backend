import { describe, expect, it } from 'vitest';
import {
  DISABLED_POLICY,
  levelFor,
  validatePolicy,
} from '../src/rewards/reward-policy.js';
import {
  parseFutureRewardInput,
  parsePostEvent,
} from '../src/rewards/post-event.js';
import { randomUUID } from 'node:crypto';

describe('Reward policy and input boundaries', () => {
  it('defaults to disabled with no invented levels or amounts', () => {
    expect(validatePolicy(DISABLED_POLICY).enabled).toBe(false);
    expect(levelFor(0n, [])).toBeNull();
  });
  it.each([
    [0n, 0],
    [9n, 0],
    [10n, 1],
    [19n, 1],
    [20n, 2],
    [999999999999999999n, 2],
  ])('calculates threshold %s as level %s', (score, level) =>
    expect(levelFor(score as bigint, [0, 10, 20])).toBe(level),
  );
  it.each([
    { levels: [1, 10] },
    { levels: [0, 10, 10] },
    { levels: [0, -1] },
    { voteWinner: 1.5 },
    { postReactions: { HELPFUL: -1 } },
    { version: '' },
    { enabled: 'yes' },
    {
      badges: [
        { code: 'A', minimumScore: 0, revokeBelow: true },
        { code: 'A', minimumScore: 1, revokeBelow: false },
      ],
    },
  ])('rejects invalid policy %j', (change) =>
    expect(() =>
      validatePolicy({ ...DISABLED_POLICY, ...change } as never),
    ).toThrow(),
  );
  it('rejects invalid proposed inputs and unavailable live event types', () => {
    expect(() => parseFutureRewardInput({ kind: 'VOTE_WIN' })).toThrow();
    expect(() => parsePostEvent({ data: '{}' })).toThrow();
  });
  function fields(type: string) {
    const postId = `post_${randomUUID()}`,
      time = new Date().toISOString();
    const value = {
      eventId: `evt_${randomUUID()}`,
      eventType: type,
      schemaVersion: 1,
      producer: 'post-service',
      aggregateId: postId,
      correlationId: 'test',
      occurredAt: time,
      postAuthorId: 1,
      postCategory: 'GENERAL',
      postVersion: 2,
      activityVersion: 2,
      post: {
        postId,
        authorId: 1,
        category: 'GENERAL',
        latitude: 0,
        longitude: 0,
        radiusM: 10,
        expiresAt: time,
        deletedAt: time,
        expiredAt: time,
      },
      comment: {
        postId,
        commentId: `comment_${randomUUID()}`,
        authorId: 2,
        content: 'fixture',
        status: 'ACTIVE',
        updatedAt: null,
        createdAt: time,
        deletedAt: time,
      },
      reaction: {
        postId,
        userId: 2,
        type: 'HELPFUL',
        createdAt: time,
        removedAt: time,
      },
      participant: {
        postId,
        userId: 2,
        joinedAt: time,
        leftAt: type === 'PostParticipantJoined' ? null : time,
        lastSeenAt: time,
      },
      actor: { type: 'USER', userId: 1 },
      reason: 'USER_REQUEST',
    };
    return {
      eventId: value.eventId,
      eventType: type,
      data: JSON.stringify(value),
    };
  }
  it.each([
    'PostCreated',
    'PostDeleted',
    'PostExpired',
    'PostCommentCreated',
    'PostCommentDeleted',
    'PostReactionCreated',
    'PostReactionRemoved',
    'PostParticipantJoined',
    'PostParticipantLeft',
  ])('parses producer envelope %s', (type) => {
    expect(parsePostEvent(fields(type)).postId).toMatch(/^post_/);
  });
  it.each([
    { schemaVersion: 2 },
    { producer: 'other' },
    { eventId: 'bad' },
    { aggregateId: 'bad' },
    { postAuthorId: '1' },
    { activityVersion: 0 },
    { postVersion: 1.5 },
    { occurredAt: 'invalid' },
  ])('rejects malformed envelope %j', (patch) => {
    const f = fields('PostReactionCreated');
    f.data = JSON.stringify({ ...JSON.parse(f.data), ...patch });
    expect(() => parsePostEvent(f)).toThrow();
  });
  it('rejects mismatched Stream metadata and future events on the live path', () => {
    const f = fields('PostReactionCreated');
    expect(() =>
      parsePostEvent({ ...f, eventId: `evt_${randomUUID()}` }),
    ).toThrow();
    expect(() =>
      parsePostEvent(fields('PostCommentReactionCreated')),
    ).toThrow();
  });
  it('accepts historical creates without optional context for later resolution', () => {
    const f = fields('PostReactionCreated'),
      v = JSON.parse(f.data);
    delete v.activityVersion;
    delete v.postAuthorId;
    expect(parsePostEvent({ ...f, data: JSON.stringify(v) })).toMatchObject({
      version: 1,
      beneficiaryId: null,
    });
  });
});
