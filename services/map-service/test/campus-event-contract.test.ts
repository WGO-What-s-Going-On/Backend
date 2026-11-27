import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parsePostCreated, parsePostStatus } from '../src/post-index.js';
import { decide } from '../src/location.js';
it('indexes the cat contest at its moved center and absolute common deadline', () => {
  const e = JSON.parse(
    readFileSync(
      resolve('../../docs/contracts/fixtures/cat-contest-post-created.json'),
      'utf8',
    ),
  );
  const post = parsePostCreated(JSON.stringify(e), {
    eventId: e.eventId,
    eventType: e.eventType,
  });
  expect(post).toMatchObject({
    latitude: 37.50456,
    longitude: 126.95694,
    radiusM: 350,
    expiresAt: new Date('2026-12-24T12:52:53.893Z'),
  });
  const now = new Date(e.occurredAt);
  expect(
    decide(
      {
        latitude: post.latitude + 0.003,
        longitude: post.longitude,
        updatedAt: now,
      },
      post,
      350,
      now,
    ).allowed,
  ).toBe(true);
  expect(
    decide(
      {
        latitude: post.latitude + 0.004,
        longitude: post.longitude,
        updatedAt: now,
      },
      post,
      350,
      now,
    ).allowed,
  ).toBe(false);
});
it.each([1, 2, 3, 4, 5])(
  'indexes the existing PostCreated/Expired contract and honors a 350m authorization boundary (reserved %s)',
  (suffix) => {
    const original = readFileSync(
      resolve('../../docs/contracts/fixtures/campus-post-created.json'),
      'utf8',
    );
    const e = JSON.parse(original);
    e.aggregateId = `post_3b16ea1a-4de6-4a2c-85be-56a64ada203${suffix}`;
    e.post.postId = e.aggregateId;
    const data = JSON.stringify(e);
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
  },
);
