import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parsePostStatus } from '../src/post-index.js';
it('invalidates the derived spatial index for a hidden post', () => {
  const eventId = `evt_${randomUUID()}`;
  const postId = `post_${randomUUID()}`;
  const eventType = 'PostHidden';
  const data = JSON.stringify({
    eventId,
    eventType,
    aggregateId: postId,
    schemaVersion: 1,
    producer: 'post-service',
    occurredAt: new Date().toISOString(),
  });
  expect(parsePostStatus(data, { eventId, eventType })).toMatchObject({
    postId,
    status: 'DELETED',
  });
});
