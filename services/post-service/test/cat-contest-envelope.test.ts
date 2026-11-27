import { expect, it } from 'vitest';
import {
  BALANCE_POST_IDS,
  CAMPUS_DURATION_MS,
  CAMPUS_POLICY,
  CAMPUS_POST_IDS,
} from '../src/post/domain/campus-events.js';
import {
  CAT_CONTEST_EXPIRES_AT,
  CAT_CONTEST_LOCATION,
  CAT_CONTEST_POST_ID,
} from '../src/post/domain/cat-contest.js';
import {
  InvalidOutboxEvent,
  serializePostEvent,
} from '../src/post/infrastructure/post-event-envelope.js';

function created() {
  return {
    eventId: 'evt_26c105d7-24f6-47b0-8917-194248066399',
    aggregateId: CAT_CONTEST_POST_ID,
    eventType: 'PostCreated',
    schemaVersion: 1,
    producer: 'post-service',
    correlationId: 'cat-outbox-regression',
    occurredAt: new Date('2026-11-27T13:27:39.630Z'),
    payload: {
      post: {
        postId: CAT_CONTEST_POST_ID,
        authorId: 1,
        category: 'NEWS',
        ...CAT_CONTEST_LOCATION,
        radiusM: 350,
        lifecyclePolicy: CAMPUS_POLICY,
        expiresAt: CAT_CONTEST_EXPIRES_AT,
      },
    },
  };
}

it('serializes the actual cat creation time and shared deadline without changing event identity', () => {
  const row = created();
  expect(JSON.parse(serializePostEvent(row))).toMatchObject({
    eventId: row.eventId,
    occurredAt: row.occurredAt.toISOString(),
    post: row.payload.post,
  });
});

it.each([
  { authorId: 2 },
  { latitude: 37.5047225 },
  { longitude: 126.9565323 },
  { radiusM: 150 },
  { expiresAt: '2026-12-24T12:52:53.894Z' },
  { lifecyclePolicy: 'OTHER' },
])('rejects altered reserved cat policy fields: %j', (fields) => {
  const row = created();
  Object.assign(row.payload.post, fields);
  expect(() => serializePostEvent(row)).toThrow(InvalidOutboxEvent);
});

it.each([CAT_CONTEST_EXPIRES_AT, '2026-12-25T00:00:00.000Z'])(
  'rejects cat creation at or after the deadline: %s',
  (occurredAt) => {
    const row = created();
    row.occurredAt = new Date(occurredAt);
    expect(() => serializePostEvent(row)).toThrow(InvalidOutboxEvent);
  },
);

it.each([...CAMPUS_POST_IDS, ...BALANCE_POST_IDS])(
  'preserves exactly 30 days for existing event %s',
  (postId) => {
    const row = created();
    row.aggregateId = postId;
    row.payload.post.postId = postId;
    row.payload.post.expiresAt = new Date(
      row.occurredAt.getTime() + CAMPUS_DURATION_MS,
    ).toISOString();
    expect(() => serializePostEvent(row)).not.toThrow();
    row.payload.post.expiresAt = CAT_CONTEST_EXPIRES_AT;
    expect(() => serializePostEvent(row)).toThrow(InvalidOutboxEvent);
  },
);

it('does not authorize an ordinary post to use the campus policy', () => {
  const row = created();
  row.aggregateId = 'post_11111111-1111-4111-8111-111111111111';
  row.payload.post.postId = row.aggregateId;
  expect(() => serializePostEvent(row)).toThrow(InvalidOutboxEvent);
  Reflect.deleteProperty(row.payload.post, 'lifecyclePolicy');
  expect(() => serializePostEvent(row)).not.toThrow();
});
