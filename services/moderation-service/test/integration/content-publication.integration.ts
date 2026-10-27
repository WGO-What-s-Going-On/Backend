import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { createClient } from 'redis';
import { CommentModerationService } from '../../src/content-moderation/comment-moderation.service.js';
import { RedisModerationResultRepository } from '../../src/content-moderation/redis-moderation-result.repository.js';
import { group, redisHarness, stream } from './redis-harness.js';

const result = {
  flagged: false,
  categories: { violence: false },
  categoryScores: { violence: 0.01 },
  model: 'fixture-model',
};
const output = 'moderation:content-events';
describe('content evaluation delivery with real Redis', () => {
  let h: Awaited<ReturnType<typeof redisHarness>>;
  const moderate = vi.fn();
  beforeEach(async () => {
    moderate.mockReset().mockResolvedValue(result);
    h = await redisHarness({ moderate });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (h?.redis.isOpen) await h.cleanup();
  });
  async function input() {
    const postId = h.postId();
    await h.lifecycle.initialize(postId, '2026-01-01T00:00:00.000Z');
    const fields = h.fields(
      'PostCommentCreated',
      postId,
      '2026-01-01T00:01:00.000Z',
      'private comment fixture',
    );
    const e = JSON.parse(fields.data);
    return {
      fields,
      input: {
        eventId: e.eventId,
        postId,
        commentId: e.comment.commentId,
        content: e.comment.content,
        correlationId: e.correlationId,
        authorId: e.comment.authorId,
        activityVersion: 1,
      },
    };
  }
  it.each([false, true])(
    'stores and publishes both flagged=%s results without source text',
    async (flagged) => {
      moderate.mockResolvedValue({ ...result, flagged });
      await h.prepare();
      const { fields } = await input();
      await h.send(fields);
      const records = await h.redis.xRange(output, '-', '+');
      expect(records).toHaveLength(1);
      const event = JSON.parse(records[0]!.message.data!);
      expect(event).toMatchObject({
        eventId: records[0]!.message.eventId,
        eventType: 'CONTENT_MODERATION_EVALUATED',
        sourceEventId: fields.eventId,
        flagged,
        targetType: 'COMMENT',
        authorId: 1,
        activityVersion: 1,
      });
      expect(JSON.stringify(event)).not.toContain('private comment');
      expect((await h.redis.xPending(stream, group)).pending).toBe(0);
      expect(await h.redis.xLen('moderation:events')).toBe(0);
    },
  );
  it('rejects wrong-type output before saving or acknowledging', async () => {
    await h.prepare();
    const { fields } = await input();
    await h.redis.set(output, 'invalid');
    await h.send(fields);
    expect(await h.results.find(fields.eventId)).toBeNull();
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    expect(
      await h.redis.exists(`moderation:content-published:${fields.eventId}`),
    ).toBe(0);
  });
  it('recovers a saved result after real XADD failure without re-evaluating or changing its ID', async () => {
    const { input: value } = await input();
    // A maximal stream ID makes XADD * fail after the result SET inside Lua.
    await h.redis.xAdd(output, '18446744073709551615-18446744073709551615', {
      sentinel: 'owned-test-data',
    });
    await expect(h.moderation.moderate(value)).rejects.toThrow(
      'CONTENT_PUBLICATION_FAILED',
    );
    const saved = await h.results.find(value.eventId);
    expect(saved).toMatchObject(result);
    expect(
      await h.redis.exists(`moderation:content-published:${value.eventId}`),
    ).toBe(0);
    await h.redis.del(output);
    const recovered = await h.moderation.moderate(
      value,
      new Date('2099-01-01'),
    );
    expect(recovered).toEqual(saved);
    expect(moderate).toHaveBeenCalledOnce();
    const event = JSON.parse(
      (await h.redis.xRange(output, '-', '+'))[0]!.message.data!,
    );
    expect(event.evaluatedAt).toBe(saved!.moderatedAt);
    await h.moderation.moderate(value);
    expect(await h.redis.xLen(output)).toBe(1);
    await h.results.republish(value.eventId);
    const replayed = await h.redis.xRange(output, '-', '+');
    expect(replayed).toHaveLength(2);
    expect(replayed[1]!.message).toEqual(replayed[0]!.message);
  });
  it('keeps one immutable output across competing workers and a lost commit response', async () => {
    const { input: value } = await input();
    await h.results.ready();
    const other = new RedisModerationResultRepository(
      new ConfigService({
        redis: {
          url:
            process.env.MODERATION_TEST_REDIS_URL ??
            'redis://localhost:6383/15',
        },
      }),
    );
    try {
      await other.ready();
      const service = new CommentModerationService(
        { moderate: async () => ({ ...result, flagged: true }) },
        other,
      );
      const connection = (
        h.results as unknown as { redis: ReturnType<typeof createClient> }
      ).redis;
      const evalOriginal = connection.eval.bind(connection);
      let lose = true;
      const spy = vi.spyOn(connection, 'eval').mockImplementation((async (
        ...args: Parameters<typeof connection.eval>
      ) => {
        const response = await evalOriginal(...args);
        if (lose) {
          lose = false;
          throw new Error('commit response lost');
        }
        return response;
      }) as typeof connection.eval);
      await Promise.allSettled([
        h.moderation.moderate(value),
        service.moderate(value),
      ]);
      spy.mockRestore();
      const canonical = await h.moderation.moderate(value);
      expect(await service.moderate(value)).toEqual(canonical);
      expect(await h.redis.xLen(output)).toBe(1);
      await expect(
        h.moderation.moderate({ ...value, content: 'changed' }),
      ).rejects.toThrow('conflicting');
    } finally {
      await other.onModuleDestroy();
    }
  });
  it('repairs legacy stored evidence and prevents re-evaluation after result retention expires', async () => {
    const { input: value } = await input();
    const stored = {
      ...result,
      eventId: value.eventId,
      postId: value.postId,
      commentId: value.commentId,
      moderatedAt: '2026-01-01T00:01:00.000Z',
    };
    await h.redis.set(
      `moderation:content:${value.eventId}`,
      JSON.stringify(stored),
    );
    await h.moderation.moderate(value);
    expect(moderate).not.toHaveBeenCalled();
    expect(await h.redis.xLen(output)).toBe(1);
    await h.redis.del(`moderation:content:${value.eventId}`);
    await expect(h.moderation.moderate(value)).rejects.toThrow(
      'retention expired',
    );
    expect(moderate).not.toHaveBeenCalled();
  });
  it('keeps committed results pending after ACK failure and recovers without publishing twice', async () => {
    await h.prepare();
    const { fields } = await input();
    const connection = (
      h.consumer as unknown as { redis: ReturnType<typeof createClient> }
    ).redis;
    const spy = vi
      .spyOn(connection, 'xAck')
      .mockRejectedValueOnce(new Error('ACK offline'));
    const id = await h.send(fields);
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    spy.mockRestore();
    await h.redis.sendCommand([
      'XCLAIM',
      stream,
      group,
      'recovery',
      '0',
      id,
      'IDLE',
      '30001',
      'JUSTID',
    ]);
    await h.consumer.pollOnce();
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
    expect(moderate).toHaveBeenCalledOnce();
    expect(await h.redis.xLen(output)).toBe(1);
  });
  it('never publishes a normal evaluation for provider outages', async () => {
    const { input: value } = await input();
    moderate.mockRejectedValue(new Error('provider offline'));
    await expect(h.moderation.moderate(value)).rejects.toThrow();
    expect(await h.redis.xLen(output)).toBe(0);
    expect(await h.results.find(value.eventId)).toBeNull();
  });
});
