import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { ContentEnforcementService } from '../src/content-moderation/content-enforcement.service.js';
import {
  contentDecision,
  parseEnforcementPolicy,
  policyFingerprint,
} from '../src/content-moderation/enforcement-policy.js';

const policy = { policyVersion: 'qa8-flagged-v1' };
const common = {
  eventId: 'evt_test',
  postId: 'post_test',
  moderatedAt: '2026-11-11T00:00:00.000Z',
  correlationId: 'request-test',
  model: 'fixture-model',
  flagged: true,
  categories: { violence: true },
  categoryScores: { violence: 0.9 },
};
const targets = [
  { ...common, targetType: 'POST' as const, postVersion: 3 },
  {
    ...common,
    targetType: 'COMMENT' as const,
    commentId: 'comment_test',
    activityVersion: 2,
  },
];

describe('flagged-only content enforcement policy', () => {
  it('never treats truthy non-boolean stored values as flagged=true', () => {
    for (const flagged of ['true', 'false', 1, null])
      expect(
        contentDecision({ ...targets[0], flagged } as never, policy),
      ).toBeNull();
  });
  it('defaults OFF without connecting or publishing', async () => {
    const service = new ContentEnforcementService(new ConfigService());
    await service.observePost('post', 1);
    await service.observeComment('post', 'comment', 1);
    await service.observePostTerminal('post');
    await service.decide(targets[0]!);
    expect(await service.isReady()).toBe(true);
    await service.onModuleDestroy();
  });
  it.each([undefined, '', {}, 'invalid version', 'x'.repeat(129)])(
    'rejects invalid policy version %j',
    (value) => {
      expect(() => parseEnforcementPolicy(value)).toThrow('policy version');
    },
  );
  it('requires Redis when enabled and rejects ambiguous enabled values', () => {
    expect(
      () =>
        new ContentEnforcementService(
          new ConfigService({ contentEnforcement: { enabled: 'true' } }),
        ),
    ).toThrow('explicit Redis URL');
    expect(
      () =>
        new ContentEnforcementService(
          new ConfigService({ contentEnforcement: { enabled: 'yes' } }),
        ),
    ).toThrow('true or false');
  });
  it.each([
    'post:events',
    'moderation:events',
    'moderation:content-events',
    'moderation:report-events',
  ])('requires decision output distinct from %s', (contentDecisionStream) => {
    expect(
      () =>
        new ContentEnforcementService(
          new ConfigService({
            redis: { url: 'redis://localhost:1', contentDecisionStream },
            contentEnforcement: {
              enabled: 'true',
              policyVersion: policy.policyVersion,
            },
          }),
        ),
    ).toThrow('separate stream');
  });
  it.each(targets)(
    'preserves $targetType identity/version and generates only HIDE for flagged=true',
    (result) => {
      const decision = contentDecision(result, policy)!;
      expect(decision).toMatchObject({
        targetType: result.targetType,
        decision: 'HIDE',
        reason: 'OPENAI_MODERATION_FLAGGED',
        sourceEventId: result.eventId,
        postId: result.postId,
        policyVersion: policy.policyVersion,
        occurredAt: result.moderatedAt,
        correlationId: result.correlationId,
      });
      if (result.targetType === 'POST') {
        expect(decision).toHaveProperty('postVersion', 3);
        expect(decision).not.toHaveProperty('commentId');
        expect(decision).not.toHaveProperty('activityVersion');
      } else {
        expect(decision).toHaveProperty('activityVersion', 2);
        expect(decision).toHaveProperty('commentId', result.commentId);
        expect(decision).not.toHaveProperty('postVersion');
      }
      expect(contentDecision({ ...result, flagged: false }, policy)).toBeNull();
      expect(
        contentDecision({ ...result, categories: { violence: false } }, policy)
          ?.decision,
      ).toBe('HIDE');
      expect(contentDecision(result, policy)).toEqual(decision);
      expect(
        contentDecision(result, { policyVersion: 'next-version' })?.eventId,
      ).not.toBe(decision.eventId);
    },
  );
  it('rejects unknown original target versions instead of guessing', () => {
    for (const value of [0, -1, undefined, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        contentDecision({ ...targets[0], postVersion: value } as never, policy),
      ).toThrow('original target version');
      expect(() =>
        contentDecision(
          { ...targets[1], activityVersion: value } as never,
          policy,
        ),
      ).toThrow('original target version');
    }
  });
  it('excludes private fields and uses a stable policy fingerprint', () => {
    const decision = contentDecision(
      {
        ...targets[0],
        title: 'private-fixture',
        content: 'private-fixture',
        apiKey: 'private-fixture',
      } as never,
      policy,
    );
    expect(JSON.stringify(decision)).not.toContain('private-fixture');
    expect(decision).not.toHaveProperty('categories');
    expect(
      policyFingerprint(parseEnforcementPolicy(policy.policyVersion)),
    ).toBe(policyFingerprint(policy));
  });
});
