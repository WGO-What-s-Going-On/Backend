import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parsePostEvent } from '../src/event-consumer/post-event.js';
const e = JSON.parse(
  readFileSync(
    resolve('../../docs/contracts/fixtures/cat-contest-post-created.json'),
    'utf8',
  ),
);
it('accepts only the reserved cat contest at the common absolute deadline', () => {
  expect(parsePostEvent(JSON.stringify(e))).toMatchObject({
    aggregateId: e.aggregateId,
    postAuthorId: '1',
    participationRadiusM: 350,
  });
  for (const post of [
    { ...e.post, expiresAt: '2026-12-27T12:00:00.000Z' },
    { ...e.post, authorId: 2 },
    { ...e.post, radiusM: 500 },
    { ...e.post, latitude: 37.5047225 },
    { ...e.post, lifecyclePolicy: undefined },
  ])
    expect(() => parsePostEvent(JSON.stringify({ ...e, post }))).toThrow(
      'created post payload',
    );
  expect(() =>
    parsePostEvent(JSON.stringify({ ...e, occurredAt: e.post.expiresAt })),
  ).toThrow('created post payload');
  const id = 'post_11111111-1111-4111-8111-111111111111';
  expect(() =>
    parsePostEvent(
      JSON.stringify({
        ...e,
        aggregateId: id,
        post: { ...e.post, postId: id },
      }),
    ),
  ).toThrow('created post payload');
  // The old five must still use their own relative 30-day contract.
  for (const suffix of [1, 2, 3, 4, 5]) {
    const postId = e.aggregateId.slice(0, -1) + suffix;
    expect(() =>
      parsePostEvent(
        JSON.stringify({
          ...e,
          aggregateId: postId,
          post: { ...e.post, postId },
        }),
      ),
    ).toThrow('created post payload');
  }
});
