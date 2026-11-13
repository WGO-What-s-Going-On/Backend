import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { createClient } from 'redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentEnforcementService } from '../../src/content-moderation/content-enforcement.service.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
import { ModerationPostEventProcessor } from '../../src/event-consumer/moderation-post-event.processor.js';
import { group, redisHarness, stream } from './redis-harness.js';

const policy = {
  policyVersion: 'qa8-flagged-v1',
};
const safe = {
  flagged: false,
  categories: { 'harassment/threatening': false },
  categoryScores: { 'harassment/threatening': 0.01 },
  model: 'fixture-model',
};
const harmful = {
  ...safe,
  flagged: true,
  categories: { 'harassment/threatening': true },
  categoryScores: { 'harassment/threatening': 0.99 },
};
const output = 'moderation:content-decisions';

describe('content decisions through Post wire, model adapter port and real Redis', () => {
  let h: Awaited<ReturnType<typeof redisHarness>>;
  const moderate = vi.fn();
  beforeEach(async () => {
    moderate.mockReset().mockResolvedValue(harmful);
    h = await redisHarness({ moderate }, undefined, policy);
    await h.prepare();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (!h?.redis.isOpen) return;
    // The harness requires an empty, exclusive test DB before starting. Remove
    // only the decision keys this suite creates; never FLUSH a shared database.
    for (const pattern of [
      'moderation:content-target:*',
      'moderation:content-decision*',
      'moderation:content-post-terminal:*',
      'moderation:content-post-target:*',
      'moderation:content-policy:*',
    ]) {
      for await (const batch of h.redis.scanIterator({ MATCH: pattern })) {
        if (batch.length) await h.redis.del(batch);
      }
    }
    await h.cleanup();
  });
  async function fixture() {
    const postId = h.postId();
    const commentId = `comment_${randomUUID()}`;
    await h.lifecycle.initialize(postId, '2026-01-01T00:00:00.000Z');
    return { postId, commentId };
  }
  function comment(
    f: { postId: string; commentId: string },
    version = 1,
    deleted = false,
  ) {
    const at = `2026-01-01T00:0${version}:00.000Z`;
    return h.fields(
      deleted
        ? 'PostCommentDeleted'
        : version === 1
          ? 'PostCommentCreated'
          : 'PostCommentUpdated',
      f.postId,
      at,
      'private synthetic fixture',
      {
        activityVersion: version,
        comment: {
          postId: f.postId,
          commentId: f.commentId,
          authorId: 1,
          ...(deleted
            ? { deletedAt: at }
            : {
                content: `private synthetic version ${version}`,
                updatedAt: at,
              }),
        },
      },
    );
  }
  function post(f: { postId: string }, version = 1) {
    return h.fields(
      version === 1 ? 'PostCreated' : 'PostUpdated',
      f.postId,
      '2026-11-11T00:00:00.000Z',
      '',
      {
        postVersion: version,
        post: {
          postId: f.postId,
          authorId: 1,
          title: `private title ${version}`,
          content: `private body ${version}`,
          closedAt: null,
        },
      },
    );
  }
  async function decisions() {
    return (await h.redis.xRange(output, '-', '+')).map((row) =>
      JSON.parse(row.message.data!),
    );
  }
  async function reclaim(id: string) {
    await h.redis.sendCommand([
      'XCLAIM',
      stream,
      group,
      'qa8-recovery',
      '0',
      id,
      'IDLE',
      '30001',
      'JUSTID',
    ]);
    await h.consumer.pollOnce();
  }

  it.each([
    ['normal', safe],
    ['harmful', harmful],
  ] as const)(
    'publishes %s decision with provenance, then ACKs without claiming Post application',
    async (_, result) => {
      moderate.mockResolvedValue(result);
      const f = await fixture();
      const message = comment(f);
      await h.send(message);
      expect(await decisions()).toMatchObject(
        result.flagged
          ? [
              {
                eventType: 'CONTENT_MODERATION_DECIDED',
                sourceEventId: message.eventId,
                decision: 'HIDE',
                reason: 'OPENAI_MODERATION_FLAGGED',
                activityVersion: 1,
                postId: f.postId,
                commentId: f.commentId,
                policyVersion: policy.policyVersion,
              },
            ]
          : [],
      );
      const [decision] = await decisions();
      if (decision) {
        expect(JSON.stringify(decision)).not.toContain('private synthetic');
        expect(decision).not.toHaveProperty('appliedAt');
      }
      expect((await h.redis.xPending(stream, group)).pending).toBe(0);
      expect(await h.redis.xLen('moderation:events')).toBe(0);
      expect((await h.lifecycle.list())[0]?.state).toBe('ACTIVE');
    },
  );
  it('publishes one decision for duplicate input and concurrent publishers', async () => {
    const f = await fixture();
    const message = comment(f);
    await h.send(message);
    await h.send(message);
    const stored = (await h.results.find(message.eventId))!;
    await Promise.all([
      h.enforcement.decide(stored),
      h.enforcement.decide(stored),
    ]);
    expect(await decisions()).toHaveLength(1);
    expect(moderate).toHaveBeenCalledOnce();
  });

  it('evaluates and decides a new comment after internal lifecycle closure without reopening it', async () => {
    const f = await fixture();
    await h.lifecycle.evaluate(f.postId, new Date('2026-01-01T01:00:00.000Z'));
    await h.lifecycle.evaluate(f.postId, new Date('2026-01-01T01:10:00.000Z'));
    expect(await h.repository.find(f.postId)).toMatchObject({
      state: 'CLOSED',
    });
    const original = comment(f);
    const message = {
      ...original,
      data: JSON.stringify({
        ...JSON.parse(original.data),
        occurredAt: '2026-01-01T01:11:00.000Z',
      }),
    };
    await h.send(message);
    await h.send(message);
    expect(moderate).toHaveBeenCalledOnce();
    expect(await h.results.find(message.eventId)).toMatchObject({
      flagged: true,
      activityVersion: 1,
    });
    expect(await decisions()).toMatchObject([
      { sourceEventId: message.eventId, decision: 'HIDE' },
    ]);
    expect(await h.redis.xLen('moderation:content-events')).toBe(1);
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
    expect(await h.repository.find(f.postId)).toMatchObject({
      state: 'CLOSED',
      lastMeaningfulActivityAt: '2026-01-01T00:00:00.000Z',
      comments: { [f.commentId]: { version: 1, deleted: false } },
    });
    expect(await h.redis.xLen('moderation:events')).toBe(2);
  });
  it.each([false, true])(
    'keeps POST evaluation and publishes HIDE only for flagged=%s',
    async (flagged) => {
      moderate.mockResolvedValue({ ...harmful, flagged });
      const f = await fixture();
      const message = post(f, 3);
      await h.send(message);
      await h.send(message);
      const records = await decisions();
      expect(records).toHaveLength(flagged ? 1 : 0);
      if (flagged) {
        expect(records[0]).toMatchObject({
          targetType: 'POST',
          postId: f.postId,
          postVersion: 3,
          sourceEventId: message.eventId,
          decision: 'HIDE',
          reason: 'OPENAI_MODERATION_FLAGGED',
        });
        expect(records[0]).not.toHaveProperty('commentId');
        expect(records[0]).not.toHaveProperty('activityVersion');
        expect(JSON.stringify(records)).not.toContain('private');
      }
      expect(await h.redis.xLen('moderation:content-events')).toBe(1);
      expect((await h.redis.xPending(stream, group)).pending).toBe(0);
      expect(moderate).toHaveBeenCalledOnce();
    },
  );
  it('preserves latest POST version while still evaluating late older edits', async () => {
    const f = await fixture();
    await h.send(post(f, 3));
    await h.send(post(f, 2));
    expect(await decisions()).toMatchObject([
      { targetType: 'POST', postVersion: 3 },
    ]);
    expect(await h.redis.xLen('moderation:content-events')).toBe(2);
    expect(moderate).toHaveBeenCalledTimes(2);
  });
  it('suppresses an old POST verdict after observing a newer safe edit', async () => {
    const f = await fixture();
    let release!: (value: typeof harmful) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    moderate
      .mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValueOnce(safe);
    const first = h.processor.process(parsePostEvent(post(f))!);
    await began;
    await h.send(post(f, 2));
    release(harmful);
    await first;
    expect(await decisions()).toHaveLength(0);
    expect(await h.redis.xLen('moderation:content-events')).toBe(2);
  });
  it('preserves safe-integer content versions without Lua JSON rounding', async () => {
    const f = await fixture();
    const version = Number.MAX_SAFE_INTEGER;
    await h.enforcement.observeComment(f.postId, f.commentId, version);
    await h.enforcement.decide({
      ...harmful,
      ...f,
      eventId: `evt_${randomUUID()}`,
      activityVersion: version,
      moderatedAt: '2026-01-01T00:01:00.000Z',
    });
    expect(await decisions()).toMatchObject([{ activityVersion: version }]);
  });
  it('fences an older model response when a newer clean edit completes first', async () => {
    const f = await fixture();
    let release!: (value: typeof harmful) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    moderate
      .mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValueOnce(safe);
    const first = h.processor.process(parsePostEvent(comment(f))!);
    await began;
    await h.send(comment(f, 2));
    release(harmful);
    await first;
    expect(await decisions()).toHaveLength(0);
    expect(await h.redis.xLen('moderation:content-events')).toBe(2);
    expect(
      (await h.lifecycle.list())[0]?.comments?.[f.commentId]?.version,
    ).toBe(2);
  });
  it('does not restore or re-evaluate older content delivered after an edit', async () => {
    const f = await fixture();
    await h.send(comment(f, 2));
    await h.send(comment(f));
    expect(await decisions()).toMatchObject([{ activityVersion: 2 }]);
    expect(moderate).toHaveBeenCalledOnce();
  });
  it('fences model completion racing with a comment deletion', async () => {
    const f = await fixture();
    let release!: (value: typeof harmful) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    moderate.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const first = h.processor.process(parsePostEvent(comment(f))!);
    await began;
    await h.send(comment(f, 2, true));
    release(harmful);
    await first;
    expect(await decisions()).toHaveLength(0);
    expect(
      (await h.lifecycle.list())[0]?.comments?.[f.commentId]?.deleted,
    ).toBe(true);
    expect(await h.redis.xLen('moderation:content-events')).toBe(1);
  });
  it('treats deletion tombstones as terminal even for a later content replay', async () => {
    const f = await fixture();
    await h.send(comment(f, 2, true));
    await h.send(comment(f, 3));
    expect(await decisions()).toHaveLength(0);
    expect(moderate).not.toHaveBeenCalled();
  });
  it.each(['PostDeleted', 'PostExpired'] as const)(
    'suppresses actionable completion after %s',
    async (type) => {
      const f = await fixture();
      let release!: (value: typeof harmful) => void;
      let started!: () => void;
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      moderate.mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      const first = h.processor.process(parsePostEvent(comment(f))!);
      await began;
      const at = '2026-01-01T00:03:00.000Z';
      await h.processor.process({
        eventId: `evt_${randomUUID()}`,
        eventType: type,
        schemaVersion: 1,
        producer: 'post-service',
        aggregateId: f.postId,
        correlationId: 'req_terminal',
        occurredAt: at,
        postVersion: 2,
        post: { postId: f.postId },
      });
      release(harmful);
      await first;
      expect(await decisions()).toHaveLength(0);
    },
  );
  it('retains input pending when decision output is unavailable and reuses the stored evaluation', async () => {
    const f = await fixture();
    await h.redis.set(output, 'test-wrong-type');
    expect(await h.enforcement.isReady()).toBe(false);
    const message = comment(f);
    const id = await h.send(message);
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    expect(await h.results.find(message.eventId)).not.toBeNull();
    await h.redis.del(output);
    expect(await h.enforcement.isReady()).toBe(true);
    await reclaim(id);
    expect(await decisions()).toHaveLength(1);
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
    expect(moderate).toHaveBeenCalledOnce();
  });
  it.each(['POST', 'COMMENT'] as const)(
    'recovers a %s XADD runtime failure without changing the prepared decision',
    async (targetType) => {
      const f = await fixture();
      await h.redis.xAdd(output, '18446744073709551615-18446744073709551615', {
        sentinel: 'test',
      });
      const message = targetType === 'POST' ? post(f) : comment(f);
      const id = await h.send(message);
      expect((await h.redis.xPending(stream, group)).pending).toBe(1);
      const [preparedKey] = await h.redis.keys(
        'moderation:content-decision:decision_*',
      );
      expect(preparedKey).toBeTruthy();
      const prepared = await h.redis.get(preparedKey!);
      await h.redis.del(output);
      await reclaim(id);
      expect(JSON.stringify((await decisions())[0])).toBe(prepared);
      expect(moderate).toHaveBeenCalledOnce();
    },
  );
  it('recovers a lost decision commit response and lost input ACK without duplicate publication', async () => {
    const f = await fixture();
    const connection = (
      h.enforcement as unknown as { redis: ReturnType<typeof createClient> }
    ).redis;
    const original = connection.eval.bind(connection);
    let lose = true;
    vi.spyOn(connection, 'eval').mockImplementation((async (
      ...args: Parameters<typeof connection.eval>
    ) => {
      const response = await original(...args);
      if (
        lose &&
        String(args[0]).includes('CONTENT_DECISION_PUBLICATION_FAILED')
      ) {
        lose = false;
        throw new Error('test response lost');
      }
      return response;
    }) as typeof connection.eval);
    const message = comment(f);
    const id = await h.send(message);
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    const consumer = (
      h.consumer as unknown as { redis: ReturnType<typeof createClient> }
    ).redis;
    vi.spyOn(consumer, 'xAck').mockRejectedValueOnce(
      new Error('test ACK unavailable'),
    );
    await reclaim(id);
    await reclaim(id);
    expect(await decisions()).toHaveLength(1);
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
    expect(moderate).toHaveBeenCalledOnce();
  });
  it('publishes neither evaluation nor decision on OpenAI failure and recovers pending input', async () => {
    const f = await fixture();
    moderate.mockRejectedValueOnce(new Error('test provider unavailable'));
    const id = await h.send(comment(f));
    expect(await decisions()).toHaveLength(0);
    expect(await h.redis.xLen('moderation:content-events')).toBe(0);
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    await reclaim(id);
    expect(await decisions()).toHaveLength(1);
  });
  it('fails before calling OpenAI when the enabled version fence cannot reach Redis', async () => {
    const unavailable = new ContentEnforcementService(
      new ConfigService({
        redis: { url: 'redis://127.0.0.1:1' },
        contentEnforcement: {
          enabled: 'true',
          policyVersion: policy.policyVersion,
        },
      }),
    );
    try {
      const f = await fixture();
      const processor = new ModerationPostEventProcessor(
        h.moderation,
        h.lifecycle,
        undefined,
        unavailable,
      );
      await expect(
        processor.process(parsePostEvent(comment(f))!),
      ).rejects.toThrow();
      expect(moderate).not.toHaveBeenCalled();
      expect(await decisions()).toHaveLength(0);
    } finally {
      await unavailable.onModuleDestroy();
    }
  });
  it('rejects a conflicting fingerprint under an existing policy version', async () => {
    const f = await fixture();
    const message = comment(f);
    await h.send(message);
    await h.redis.set(
      `moderation:content-policy:${policy.policyVersion}`,
      'different-policy-fingerprint',
    );
    const other = new ContentEnforcementService(
      new ConfigService({
        redis: {
          url:
            process.env.MODERATION_TEST_REDIS_URL ??
            'redis://localhost:6383/15',
        },
        contentEnforcement: {
          enabled: 'true',
          policyVersion: policy.policyVersion,
        },
      }),
    );
    try {
      expect(await other.isReady()).toBe(false);
      await expect(
        other.decide((await h.results.find(message.eventId))!),
      ).rejects.toThrow('CONTENT_POLICY_VERSION_REUSED');
      expect(await decisions()).toHaveLength(1);
    } finally {
      await other.onModuleDestroy();
    }
  });
});
