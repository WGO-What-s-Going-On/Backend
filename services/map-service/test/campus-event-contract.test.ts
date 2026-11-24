import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parsePostCreated, parsePostStatus } from '../src/post-index.js';
import { decide } from '../src/location.js';
it('indexes the existing PostCreated/Expired contract and honors a 350m authorization boundary', () => {
  const data = readFileSync(
    resolve('../../docs/contracts/fixtures/campus-post-created.json'),
    'utf8',
  );
  const e = JSON.parse(data);
  const post = parsePostCreated(data, {
    eventId: e.eventId,
    eventType: e.eventType,
  });
  expect(post.radiusM).toBe(350);
  expect(post.expiresAt?.toISOString()).toBe(e.post.expiresAt);
  const now = new Date();
  expect(
    decide(
      { latitude: 0.003, longitude: 0, updatedAt: now },
      post,
      post.radiusM,
      now,
    ).allowed,
  ).toBe(true);
  expect(
    decide(
      { latitude: 0.004, longitude: 0, updatedAt: now },
      post,
      post.radiusM,
      now,
    ).allowed,
  ).toBe(false);
  const expired = {
    ...e,
    eventType: 'PostExpired',
    postVersion: 2,
    occurredAt: e.post.expiresAt,
    post: {
      postId: e.aggregateId,
      authorId: 42,
      category: 'NEWS',
      expiresAt: e.post.expiresAt,
      expiredAt: e.post.expiresAt,
    },
  };
  expect(
    parsePostStatus(JSON.stringify(expired), {
      eventId: e.eventId,
      eventType: 'PostExpired',
    }).status,
  ).toBe('EXPIRED');
});
