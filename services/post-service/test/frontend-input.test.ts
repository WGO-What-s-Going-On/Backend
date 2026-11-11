import { postInput } from '../src/post/presentation/post.input.js';
import { createPost } from '../src/post/domain/post.js';
import { expect, it } from 'vitest';
import { activityLevel } from '../src/post/activity.controller.js';
import { nearbyInput } from '../src/post/nearby.controller.js';
it('requires all previous title thresholds and counts ten points per pick', () => {
  expect(activityLevel(9, 100, 100).title).toBe('소식통');
  expect(activityLevel(10, 9, 100).title).toBe('리포터');
  expect(activityLevel(10, 10, 4).title).toBe('특파원');
  expect(activityLevel(10, 10, 5)).toMatchObject({
    title: '천리안',
    level: 4,
    score: 50,
  });
});
it('binds nearby cursors to coordinates and filters', () => {
  const input = nearbyInput({
    latitude: '37',
    longitude: '127',
    category: 'NEWS',
  });
  const cursor = Buffer.from(
    JSON.stringify({ scope: input.scope, key: 10, id: 'post_x' }),
  ).toString('base64url');
  expect(
    nearbyInput({ latitude: '37', longitude: '127', category: 'NEWS', cursor })
      .after?.key,
  ).toBe(10);
  expect(() =>
    nearbyInput({ latitude: '37', longitude: '127', category: 'HELP', cursor }),
  ).toThrow('cursor');
  expect(() => nearbyInput({ latitude: ['37'], longitude: '127' })).toThrow();
  expect(() =>
    nearbyInput({ latitude: '37', longitude: '127', limit: '101' }),
  ).toThrow();
});

const draft = {
  title: 'test',
  content: 'test',
  category: 'NEWS',
  latitude: 37,
  longitude: 127,
  radiusM: 100,
};
it('accepts cover focus percentages and preserves omission as null', () => {
  expect(
    createPost(postInput(draft), 1, 'test', new Date()).coverFocus,
  ).toBeNull();
  const input = postInput({
    ...draft,
    mediaIds: ['media_123e4567-e89b-42d3-a456-426614174000'],
    coverFocus: { x: 0, y: 100 },
  });
  expect(createPost(input, 1, 'test', new Date()).coverFocus).toEqual({
    x: 0,
    y: 100,
  });
});
it.each([
  null,
  [],
  {},
  { x: 1 },
  { x: -1, y: 1 },
  { x: 101, y: 1 },
  { x: 1.5, y: 1 },
  { x: '1', y: 1 },
  { x: 1, y: 1, z: 1 },
])('rejects invalid cover focus %j', (coverFocus) => {
  expect(() => postInput({ ...draft, coverFocus })).toThrow();
});
it('rejects cover focus without attachments', () => {
  expect(() =>
    createPost(
      postInput({ ...draft, coverFocus: { x: 50, y: 50 } }),
      1,
      'test',
      new Date(),
    ),
  ).toThrow('coverFocus requires mediaIds');
});
