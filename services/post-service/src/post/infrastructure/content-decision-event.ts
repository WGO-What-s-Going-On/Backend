import { createHash } from 'node:crypto';
import type { ContentDecision } from '../application/content-decision.js';
export class InvalidContentDecision extends Error {}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const CONTENT_POLICY = 'openai-flagged-hide-v1';
export const CONTENT_POLICY_FINGERPRINT = hash(
  JSON.stringify({
    policyVersion: CONTENT_POLICY,
    condition: 'flagged=true',
    decision: 'HIDE',
    reason: 'OPENAI_MODERATION_FLAGGED',
  }),
);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
const id = (v: unknown, prefix: string): v is string =>
  typeof v === 'string' &&
  new RegExp(
    `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  ).test(v);
const version = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function parseContentDecision(
  fields: Record<string, string>,
): ContentDecision {
  try {
    if (!fields.data || Buffer.byteLength(fields.data) > 16384)
      throw new Error();
    const v: unknown = JSON.parse(fields.data);
    if (
      !object(v) ||
      v.eventType !== 'CONTENT_MODERATION_DECIDED' ||
      v.eventType !== fields.eventType ||
      v.eventId !== fields.eventId ||
      v.schemaVersion !== 1 ||
      v.producer !== 'moderation-service' ||
      !id(v.postId, 'post') ||
      !id(v.sourceEventId, 'evt') ||
      !text(v.correlationId) ||
      !text(v.occurredAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(
        v.occurredAt,
      ) ||
      !Number.isFinite(Date.parse(v.occurredAt)) ||
      v.policyVersion !== CONTENT_POLICY ||
      v.policyFingerprint !== CONTENT_POLICY_FINGERPRINT ||
      v.decision !== 'HIDE' ||
      v.reason !== 'OPENAI_MODERATION_FLAGGED'
    )
      throw new Error();
    const evaluationEventId = `evt_content_${hash(v.sourceEventId)}`;
    const identity = hash(JSON.stringify([evaluationEventId, CONTENT_POLICY]));
    const eventId = `evt_decision_${identity}`;
    const moderationDecisionId = `decision_${identity}`;
    if (
      v.evaluationEventId !== evaluationEventId ||
      v.eventId !== eventId ||
      v.moderationDecisionId !== moderationDecisionId
    )
      throw new Error();
    const common = {
      eventId,
      eventType: 'CONTENT_MODERATION_DECIDED' as const,
      moderationDecisionId,
      sourceEventId: v.sourceEventId,
      evaluationEventId,
      policyVersion: CONTENT_POLICY,
      policyFingerprint: CONTENT_POLICY_FINGERPRINT,
      postId: v.postId,
      correlationId: v.correlationId,
      occurredAt: new Date(v.occurredAt),
    };
    if (
      v.targetType === 'POST' &&
      version(v.postVersion) &&
      !('commentId' in v) &&
      !('activityVersion' in v)
    )
      return { ...common, targetType: 'POST', postVersion: v.postVersion };
    if (
      v.targetType === 'COMMENT' &&
      id(v.commentId, 'comment') &&
      version(v.activityVersion) &&
      !('postVersion' in v)
    )
      return {
        ...common,
        targetType: 'COMMENT',
        commentId: v.commentId,
        activityVersion: v.activityVersion,
      };
    throw new Error();
  } catch {
    throw new InvalidContentDecision('Invalid content decision contract');
  }
}
