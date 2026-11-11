import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseContentDecision } from '../src/post/infrastructure/content-decision-event.js';
import { decisionFields } from './helpers/content-decision.js';
const postId = `post_${randomUUID()}`;
it('parses both approved versioned targets with producer identity', () => {
  expect(parseContentDecision(decisionFields(postId))).toMatchObject({
    targetType: 'POST',
    postVersion: 1,
    postId,
  });
  const target = {
    targetType: 'COMMENT' as const,
    commentId: `comment_${randomUUID()}`,
    activityVersion: 2,
  };
  expect(parseContentDecision(decisionFields(postId, target))).toMatchObject(
    target,
  );
});
it.each([
  { decision: 'DELETE' },
  { reason: 'other' },
  { producer: 'post-service' },
  { schemaVersion: 2 },
  { eventId: 'evt_invalid' },
  { moderationDecisionId: 'decision_invalid' },
  { policyVersion: 'unapproved' },
  { policyFingerprint: '0'.repeat(64) },
  { evaluationEventId: 'evt_content_' + '0'.repeat(64) },
  { postVersion: 0 },
  { postVersion: 1.5 },
  { postVersion: null },
  { activityVersion: 1 },
  { commentId: 'comment_invalid' },
  { occurredAt: 'invalid' },
  { sourceEventId: 'other' },
  { correlationId: '' },
  { targetType: 'USER' },
])('rejects malformed or unapproved decision %j', (patch) => {
  const fields = decisionFields(postId);
  fields.data = JSON.stringify({ ...JSON.parse(fields.data), ...patch });
  expect(() => parseContentDecision(fields)).toThrow();
});
it('never treats an evaluation as a hide command', () => {
  const fields = decisionFields(postId);
  fields.eventType = 'CONTENT_MODERATION_EVALUATED';
  expect(() => parseContentDecision(fields)).toThrow();
});
