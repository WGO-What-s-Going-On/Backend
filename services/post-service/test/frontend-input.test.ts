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
