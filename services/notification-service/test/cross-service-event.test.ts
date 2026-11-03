import { describe, expect, it } from 'vitest';
import { parseUserEvent } from '../src/event-consumer/user-event.js';
import { parseModerationEvent } from '../src/event-consumer/moderation-event.js';

function user(
  type = 'USER_BADGE_GRANTED',
  payload: Record<string, unknown> = {},
) {
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    type,
    version: 1,
    producer: 'user-service',
    target: { type: 'USER', id: '42' },
    correlationId: 'regional-ranking:test',
    occurredAt: '2026-11-03T00:00:00Z',
    payload: {
      userId: '42',
      sourceEventId: 'regional-ranking:run',
      policyVersion: 'wgo-titles-v2',
      badgeId: '1',
      ...payload,
    },
  };
}
function fields(v: Record<string, unknown>) {
  return {
    eventId: String(v.eventId),
    eventType: String(v.type ?? v.eventType),
    data: JSON.stringify(v),
  };
}
describe('User and Moderation wire boundaries', () => {
  it('consumes the distinct User type/version/target/payload and preserves null regionName', () => {
    expect(
      parseUserEvent(
        fields(
          user('USER_BADGE_GRANTED', {
            badgeCode: 'CLAIRVOYANT',
            badgeName: '천리안',
            regionCode: '1159053000',
            regionName: null,
            rank: '1',
            score: '3',
          }),
        ),
      ),
    ).toMatchObject({
      userId: '42',
      payload: { regionName: null, score: '3' },
    });
  });
  it.each(['INITIAL', 'UP', 'DOWN'])(
    'validates %s level direction',
    (changeType) => {
      const previousLevel = changeType === 'INITIAL' ? null : 3,
        level = changeType === 'DOWN' ? 2 : 4;
      expect(
        parseUserEvent(
          fields(
            user('USER_LEVEL_CHANGED', { changeType, previousLevel, level }),
          ),
        ),
      ).toMatchObject({ type: 'USER_LEVEL_CHANGED' });
    },
  );
  it.each([
    { target: { type: 'USER', id: '99' } },
    { producer: 'post-service' },
    { version: 2 },
    { type: 'USER_BADGE_GRANTED', payload: { userId: '42', badgeId: 1 } },
  ])('rejects invalid User contract %j', (extra) => {
    expect(() => parseUserEvent(fields({ ...user(), ...extra }))).toThrow(
      'Invalid',
    );
  });
  it('accepts valid credit facts without turning them into a badge or level', () => {
    expect(
      parseUserEvent(
        fields(
          user('USER_CREDIT_CHANGED', {
            ledgerId: '1',
            delta: '-2',
            credits: '8',
            growthScore: '8',
          }),
        ),
      ).type,
    ).toBe('USER_CREDIT_CHANGED');
  });
  it('keeps report acknowledgement and cancellation distinct from reviewed decisions', () => {
    const report = {
      eventId: 'report-event',
      eventType: 'REPORT_CREATED',
      schemaVersion: 1,
      producer: 'moderation-service',
      occurredAt: '2026-11-03T00:00:00Z',
      data: {
        reportId: 'report_11111111-1111-4111-8111-111111111111',
        reporterUserId: '42',
        targetType: 'POST',
        postId: 'post_1',
        reason: 'SPAM',
      },
    };
    expect(
      parseModerationEvent(fields(report), 'moderation:report-events'),
    ).toMatchObject({ recipient: '42', eventType: 'REPORT_CREATED' });
    expect(() =>
      parseModerationEvent(
        fields({ ...report, producer: 'post-service' }),
        'moderation:report-events',
      ),
    ).toThrow('Invalid');
  });
  it('parses an AI observation without a sanction recipient', () => {
    const v = {
      eventId: 'evt_content_123',
      eventType: 'CONTENT_MODERATION_EVALUATED',
      schemaVersion: 1,
      producer: 'moderation-service',
      occurredAt: '2026-11-03T00:00:00Z',
      postId: 'post_1',
      commentId: 'comment_1',
      flagged: true,
    };
    expect(
      parseModerationEvent(fields(v), 'moderation:content-events'),
    ).not.toHaveProperty('recipient');
  });
});
