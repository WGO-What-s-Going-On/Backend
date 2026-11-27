import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parsePostEvent } from '../src/event-consumer/post-event.js';
import {
  evaluateLifecycle,
  type LifecycleProjection,
} from '../src/lifecycle/lifecycle.js';
const e = JSON.parse(
  readFileSync(
    resolve('../../docs/contracts/fixtures/cat-contest-post-created.json'),
    'utf8',
  ),
);
const parse = (value: any) =>
  parsePostEvent({
    eventId: value.eventId,
    eventType: value.eventType,
    data: JSON.stringify(value),
  });
it('accepts the one fixed deadline and rejects different IDs, authors and deadlines', () => {
  expect(parse(e)?.post?.expiresAt).toBe(e.post.expiresAt);
  for (const post of [
    { ...e.post, expiresAt: '2026-12-27T12:00:00.000Z' },
    { ...e.post, authorId: 2 },
    { ...e.post, radiusM: 500 },
  ])
    expect(() => parse({ ...e, post })).toThrow('campus');
  expect(() => parse({ ...e, occurredAt: e.post.expiresAt })).toThrow('campus');
  const postId = 'ordinary';
  expect(() =>
    parse({ ...e, aggregateId: postId, post: { ...e.post, postId } }),
  ).toThrow('campus');
  for (const suffix of [1, 2, 3, 4, 5]) {
    const id = e.aggregateId.slice(0, -1) + suffix;
    expect(() =>
      parse({ ...e, aggregateId: id, post: { ...e.post, postId: id } }),
    ).toThrow('campus');
  }
});
it('keeps the actual contest ACTIVE through inactivity and ENDED until Post expiry', () => {
  const p: LifecycleProjection = {
    postId: e.aggregateId,
    state: 'ACTIVE',
    createdAt: e.occurredAt,
    lastMeaningfulActivityAt: e.occurredAt,
    staleAt: null,
    version: 0,
    lifecyclePolicy: e.post.lifecyclePolicy,
    expiresAt: e.post.expiresAt,
    reactionHistoryComplete: true,
    reactions: Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        String(i),
        {
          userId: i + 1,
          type: 'ENDED' as const,
          active: true,
          version: 1,
          createdAt: e.occurredAt,
        },
      ]),
    ),
  };
  for (const now of [
    new Date(e.occurredAt),
    new Date(Date.parse(e.occurredAt) + 3600000),
    new Date(Date.parse(e.post.expiresAt) - 1),
    new Date(e.post.expiresAt),
  ])
    expect(evaluateLifecycle(p, now)).toEqual({ projection: p });
  expect(
    evaluateLifecycle(
      { ...p, postId: 'ordinary' },
      new Date(Date.parse(e.occurredAt) + 3600000),
    ).projection.state,
  ).toBe('STALE');
  const { lifecyclePolicy: _policy, ...withoutPolicy } = p;
  expect(
    evaluateLifecycle(
      withoutPolicy,
      new Date(Date.parse(e.occurredAt) + 3600000),
    ).projection.state,
  ).toBe('STALE');
});
