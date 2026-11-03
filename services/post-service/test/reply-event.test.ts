import { expect, it } from 'vitest';
import { event } from '../src/post/application/event.js';
import { serializePostEvent } from '../src/post/infrastructure/post-event-envelope.js';
it('preserves verified parent identity in replies while accepting historical v1 events', () => {
  const postId = 'post_11111111-1111-4111-8111-111111111111',
    parentCommentId = 'comment_22222222-2222-4222-8222-222222222222',
    now = new Date();
  const payload = {
    comment: {
      postId,
      commentId: 'comment_33333333-3333-4333-8333-333333333333',
      authorId: 2,
      parentCommentId,
      content: 'reply',
      createdAt: now,
      updatedAt: null,
      status: 'ACTIVE',
    },
    postAuthorId: 1,
    postCategory: 'NEWS',
    activityVersion: 1,
  };
  const make = (extra: Record<string, unknown>) =>
    event(postId, 'PostCommentCreated', { ...payload, ...extra }, now);
  expect(
    JSON.parse(serializePostEvent(make({ parentCommentAuthorId: 3 }))),
  ).toMatchObject({ parentCommentAuthorId: 3, comment: { parentCommentId } });
  expect(() => serializePostEvent(make({}))).not.toThrow();
  expect(() =>
    serializePostEvent(make({ parentCommentAuthorId: 0 })),
  ).toThrow();
  expect(() =>
    serializePostEvent(
      make({
        parentCommentAuthorId: 3,
        comment: { ...payload.comment, parentCommentId: null },
      }),
    ),
  ).toThrow();
});
