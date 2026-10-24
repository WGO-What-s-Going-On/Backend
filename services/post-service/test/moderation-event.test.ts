import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseModerationEvent } from '../src/post/infrastructure/moderation-event.js';

function fields(type = 'BOARD_CLOSED') {
  const postId = `post_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;
  return {
    eventId,
    eventType: type,
    data: JSON.stringify({
      eventId,
      eventType: type,
      aggregateId: postId,
      schemaVersion: 1,
      producer: 'moderation-service',
      correlationId: 'req-test',
      occurredAt: new Date().toISOString(),
      payload: {
        postId,
        state: {
          BOARD_STALE: 'STALE',
          BOARD_REACTIVATED: 'ACTIVE',
          BOARD_CLOSED: 'CLOSED',
        }[type],
      },
    }),
  };
}

describe('Moderation v1 event contract', () => {
  it.each(['BOARD_STALE', 'BOARD_REACTIVATED', 'BOARD_CLOSED'])(
    'accepts existing %s without inventing version or reason',
    (type) => {
      expect(parseModerationEvent(fields(type))?.eventType).toBe(type);
    },
  );
  it.each([
    { schemaVersion: 2 },
    { producer: 'post-service' },
    { aggregateId: `post_${randomUUID()}` },
    { payload: { postId: 'invalid', state: 'CLOSED' } },
    { occurredAt: 'yesterday' },
  ])('rejects malformed supported events: %j', (change) => {
    const wire = fields();
    wire.data = JSON.stringify({ ...JSON.parse(wire.data), ...change });
    expect(() => parseModerationEvent(wire)).toThrow();
  });
  it('rejects mismatched wire IDs and event types', () => {
    const wire = fields();
    expect(() =>
      parseModerationEvent({ ...wire, eventId: `evt_${randomUUID()}` }),
    ).toThrow();
    expect(() =>
      parseModerationEvent({ ...wire, eventType: 'BOARD_STALE' }),
    ).toThrow();
  });
  it('ignores unrelated event types', () => {
    expect(parseModerationEvent({ eventType: 'UNRELATED' })).toBeNull();
  });
});
