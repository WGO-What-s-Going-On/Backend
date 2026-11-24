import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parsePostEvent } from '../src/event-consumer/post-event.js';
it('accepts the additive campus policy without changing Notification activity identity', () => {
  const data = readFileSync(
    resolve('../../docs/contracts/fixtures/campus-post-created.json'),
    'utf8',
  );
  const e = JSON.parse(data);
  expect(
    parsePostEvent(data, { eventId: e.eventId, eventType: e.eventType }),
  ).toMatchObject({
    aggregateId: e.aggregateId,
    postAuthorId: '42',
    participationRadiusM: 350,
  });
  const other = {
    ...e,
    aggregateId: 'post_11111111-1111-4111-8111-111111111111',
    post: { ...e.post, postId: 'post_11111111-1111-4111-8111-111111111111' },
  };
  expect(() => parsePostEvent(JSON.stringify(other))).toThrow(
    'created post payload',
  );
  expect(() =>
    parsePostEvent(
      JSON.stringify({ ...e, post: { ...e.post, expiresAt: e.occurredAt } }),
    ),
  ).toThrow('created post payload');
});
