import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { realtimePostEvent } from '../src/realtime/post-event-contract.js';

function fields(type: string, extra: object = {}) {
  const eventId = `evt_${randomUUID()}`;
  const postId = `post_${randomUUID()}`;
  return {
    eventId,
    eventType: type,
    data: JSON.stringify({
      eventId,
      eventType: type,
      aggregateId: postId,
      producer: 'post-service',
      schemaVersion: 1,
      correlationId: 'req-test',
      occurredAt: new Date().toISOString(),
      post: {
        postId,
        deletedAt: new Date().toISOString(),
        expiredAt: new Date().toISOString(),
      },
      postVersion: 2,
      comment: {
        postId,
        commentId: `comment_${randomUUID()}`,
        deletedAt: new Date().toISOString(),
        content: 'private removed body',
      },
      activityVersion: 2,
      ...extra,
    }),
  };
}
describe('Post realtime contract', () => {
  it.each([
    ['PostDeleted', 'post.deleted'],
    ['PostExpired', 'post.expired'],
    ['PostCommentDeleted', 'comment.deleted'],
  ])('maps %s without deleted content', (type, expected) => {
    const message = realtimePostEvent(fields(type!));
    expect(message?.type).toBe(expected);
    expect(JSON.stringify(message)).not.toContain('private removed body');
  });
  it('rejects unsupported version and mismatched targets', () => {
    expect(() =>
      realtimePostEvent(fields('PostDeleted', { schemaVersion: 2 })),
    ).toThrow();
    expect(() =>
      realtimePostEvent(
        fields('PostCommentDeleted', { comment: { postId: 'other' } }),
      ),
    ).toThrow();
  });
  it('skips unrelated types', () =>
    expect(realtimePostEvent(fields('PostParticipantLeft'))).toBeNull());
});

it('accepts versioned author closure updates without exposing author identity', () => {
  const value = {
    eventId: 'evt_update',
    eventType: 'PostUpdated',
    aggregateId: 'post_1',
    producer: 'post-service',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    postVersion: 2,
    post: { postId: 'post_1', authorId: 123, closedAt: null },
  };
  const parsed = realtimePostEvent({
    eventId: value.eventId,
    eventType: value.eventType,
    data: JSON.stringify(value),
  });
  expect(parsed).toMatchObject({
    type: 'post.updated',
    postVersion: 2,
    closedAt: null,
  });
  expect(parsed).not.toHaveProperty('authorId');
});
