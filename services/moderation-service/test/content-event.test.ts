import { describe, expect, it } from 'vitest';
import { contentEvent } from '../src/content-moderation/content-event.js';
describe('content evaluation event', () => {
  it.each([true, false])(
    'publishes evaluation, never a sanction (flagged=%s)',
    (flagged) => {
      const stored = {
        eventId: 'evt_source',
        postId: 'p',
        commentId: 'c',
        moderatedAt: '2026-10-27T00:00:00.000Z',
        correlationId: 'req',
        authorId: 42,
        activityVersion: 1,
        flagged,
        categories: { violence: flagged },
        categoryScores: { violence: 0.3 },
        model: 'fixture',
      };
      const event = contentEvent(stored);
      expect(event).toMatchObject({
        eventType: 'CONTENT_MODERATION_EVALUATED',
        schemaVersion: 1,
        producer: 'moderation-service',
        sourceEventId: 'evt_source',
        targetType: 'COMMENT',
        correlationId: 'req',
        flagged,
      });
      expect(event.eventId).toBe(contentEvent({ ...stored }).eventId);
      expect(event).not.toHaveProperty('content');
      expect(event).not.toHaveProperty('decision');
    },
  );
});
