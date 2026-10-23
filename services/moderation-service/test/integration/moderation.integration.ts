import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleScheduler } from '../../src/lifecycle/lifecycle.scheduler.js';
import { dead, group, output, redisHarness, stream } from './redis-harness.js';

const start = '2026-01-01T00:00:00.000Z';
const commentAt = '2026-01-01T00:40:00.000Z';
const now = new Date('2026-01-01T02:00:00.000Z');
const result = {
  flagged: false,
  categories: { violence: false },
  categoryScores: { violence: 0.01 },
  model: 'omni-moderation-latest',
};

describe('Moderation production components with real Redis', () => {
  let h: Awaited<ReturnType<typeof redisHarness>>;
  const moderate = vi.fn();

  beforeEach(async () => {
    moderate.mockReset().mockResolvedValue(result);
    h = await redisHarness({ moderate });
  });
  afterEach(async () => {
    if (h?.redis.isOpen) await h.cleanup();
  });

  async function noPending() {
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
  }
  async function events() {
    return (await h.redis.xRange(output, '-', '+')).map(({ message }) => {
      const event = JSON.parse(message.data!);
      expect(message.eventId).toBe(event.eventId);
      expect(message.eventType).toBe(event.eventType);
      expect(event).toMatchObject({
        schemaVersion: 1,
        producer: 'moderation-service',
        payload: { postId: event.aggregateId },
      });
      expect(event.eventId).toMatch(/^evt_/);
      expect(event.correlationId).toMatch(/^req_/);
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
      return event;
    });
  }

  it('creates the group on startup, consumes PostCreated, ACKs and preserves projection on duplicate', async () => {
    const id = h.postId();
    const message = h.fields('PostCreated', id, start);
    await h.redis.xAdd(stream, '*', message);
    await h.consumer.onModuleInit();
    await expect
      .poll(() => h.redis.get(`moderation:dedup:${message.eventId}`))
      .toBe('done');
    expect(await h.repository.find(id)).toEqual({
      postId: id,
      state: 'ACTIVE',
      createdAt: start,
      lastMeaningfulActivityAt: start,
      staleAt: null,
      version: 0,
      reactionHistoryComplete: true,
    });
    const original = await h.repository.find(id);
    await h.redis.xAdd(stream, '*', {
      ...message,
      data: JSON.stringify({
        ...JSON.parse(message.data),
        occurredAt: commentAt,
      }),
    });
    await expect
      .poll(async () => (await h.redis.xInfoGroups(stream))[0]?.lag)
      .toBe(0);
    await expect
      .poll(async () => (await h.redis.xPending(stream, group)).pending)
      .toBe(0);
    expect(await h.repository.find(id)).toEqual(original);
    expect((await h.redis.xInfoGroups(stream))[0]?.name).toBe(group);
    expect((await h.redis.xInfoConsumers(stream, group)).length).toBe(1);
    expect(await events()).toEqual([]);
    expect(moderate).not.toHaveBeenCalled();
  });

  it.each(['PostReactionCreated', 'PostParticipantJoined'] as const)(
    'recognizes and ACKs %s without activity or output',
    async (type) => {
      await h.prepare();
      const id = h.postId();
      await h.lifecycle.initialize(id, start);
      const original = await h.repository.find(id);
      const message = h.fields(type, id, commentAt);
      await h.send(message);
      await noPending();
      expect(await h.redis.get(`moderation:dedup:${message.eventId}`)).toBe(
        'done',
      );
      expect(await h.repository.find(id)).toEqual(original);
      expect(await events()).toEqual([]);
      expect(moderate).not.toHaveBeenCalled();
    },
  );

  it('moderates ACTIVE comments, persists NX results, deduplicates and rejects backward activity', async () => {
    await h.prepare();
    const id = h.postId();
    await h.lifecycle.initialize(id, start);
    const message = h.fields('PostCommentCreated', id, commentAt);
    await h.send(message);
    await noPending();
    const stored = await h.results.find(message.eventId);
    expect(stored).toMatchObject({
      ...result,
      eventId: message.eventId,
      postId: id,
    });
    expect(
      await h.redis.ttl(`moderation:content:${message.eventId}`),
    ).toBeGreaterThan(2_591_900);
    expect(await h.results.save({ ...stored!, flagged: true })).toBe(false);
    const projection = await h.repository.find(id);
    expect(projection).toMatchObject({
      state: 'ACTIVE',
      lastMeaningfulActivityAt: commentAt,
      version: 1,
    });
    await h.send(message);
    expect(moderate).toHaveBeenCalledOnce();
    expect(await h.repository.find(id)).toEqual(projection);
    // Consumer dedup과 별개로 저장된 moderation 결과가 API 재호출을 막는지 검증한다.
    await h.redis.del(`moderation:dedup:${message.eventId}`);
    await h.send(message);
    expect(moderate).toHaveBeenCalledOnce();
    expect(await h.results.find(message.eventId)).toEqual(stored);
    await h.send(
      h.fields('PostCommentCreated', id, '2026-01-01T00:20:00.000Z'),
    );
    expect(await h.repository.find(id)).toMatchObject({
      state: 'ACTIVE',
      lastMeaningfulActivityAt: commentAt,
    });
    expect(await events()).toEqual([]);
    await noPending();
  });

  it('reactivates STALE once with source correlationId and keeps CLOSED terminal', async () => {
    await h.prepare();
    const id = h.postId();
    await h.lifecycle.initialize(id, start);
    await h.lifecycle.evaluate(id, now);
    const message = h.fields(
      'PostCommentCreated',
      id,
      '2026-01-01T02:01:00.000Z',
    );
    await h.send(message);
    expect(await h.repository.find(id)).toMatchObject({
      state: 'ACTIVE',
      staleAt: null,
      lastMeaningfulActivityAt: '2026-01-01T02:01:00.000Z',
      version: 2,
    });
    await h.send(message);
    const published = await events();
    expect(published.map((e) => e.eventType)).toEqual([
      'BOARD_STALE',
      'BOARD_REACTIVATED',
    ]);
    expect(published[1]).toMatchObject({
      aggregateId: id,
      correlationId: JSON.parse(message.data).correlationId,
      occurredAt: '2026-01-01T02:01:00.000Z',
      payload: { postId: id, state: 'ACTIVE' },
    });
    await h.lifecycle.evaluate(id, new Date('2026-01-01T03:00:00.000Z'));
    await h.lifecycle.evaluate(id, new Date('2026-01-01T03:10:00.000Z'));
    const closed = await h.repository.find(id);
    await h.send(
      h.fields('PostCommentCreated', id, '2026-01-01T03:11:00.000Z'),
    );
    expect(await h.repository.find(id)).toEqual(closed);
    expect(closed?.state).toBe('CLOSED');
    expect((await events()).map((e) => e.eventType)).toEqual([
      'BOARD_STALE',
      'BOARD_REACTIVATED',
      'BOARD_STALE',
      'BOARD_CLOSED',
    ]);
    await noPending();
  });

  it('retains failed entries pending, recovers consumer A via XAUTOCLAIM and ACKs once', async () => {
    await h.prepare();
    const id = h.postId();
    await h.lifecycle.initialize(id, start);
    const message = h.fields('PostCommentCreated', id, commentAt);
    const entryId = await h.redis.xAdd(stream, '*', message);
    const read = (await h.redis.xReadGroup(group, 'consumer-A', {
      key: stream,
      id: '>',
    })) as unknown as Array<{
      messages: Array<{ id: string; message: Record<string, string> }>;
    }>;
    moderate.mockRejectedValueOnce(new Error('temporary provider failure'));
    await h.consumer.process(read![0]!.messages[0]!);
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    expect(await h.results.find(message.eventId)).toBeNull();
    expect(await h.redis.get(`moderation:dedup:${message.eventId}`)).toBeNull();
    // Redis가 제공하는 IDLE로 PEL 나이를 준비하여 production 30초 threshold를 그대로 검증한다.
    await h.redis.sendCommand([
      'XCLAIM',
      stream,
      group,
      'consumer-A',
      '0',
      entryId,
      'IDLE',
      '30001',
      'JUSTID',
    ]);
    await h.consumer.pollOnce();
    await noPending();
    expect(moderate).toHaveBeenCalledTimes(2);
    expect(await h.repository.find(id)).toMatchObject({
      lastMeaningfulActivityAt: commentAt,
      version: 1,
    });
    expect(
      (await h.redis.xInfoConsumers(stream, group)).some((c) =>
        c.name.startsWith('moderation-'),
      ),
    ).toBe(true);
    await h.send(message);
    expect(moderate).toHaveBeenCalledTimes(2);
    expect(await events()).toEqual([]);
  });

  it('dead-letters malformed JSON with identifiers/reason and removes pending', async () => {
    await h.prepare();
    const message = h.fields('PostCreated', h.postId(), start);
    const entryId = await h.send({ ...message, data: '{' });
    await noPending();
    expect((await h.redis.xRange(dead, '-', '+'))[0]?.message).toEqual({
      streamId: entryId,
      eventId: message.eventId,
      error: 'Error: Invalid post event JSON',
      data: '{',
    });
  });

  it('dead-letters poison events after exactly five real deliveries', async () => {
    await h.prepare();
    const id = h.postId();
    await h.lifecycle.initialize(id, start);
    const message = h.fields('PostCommentCreated', id, commentAt);
    moderate.mockRejectedValue(new Error('provider unavailable'));
    const entryId = await h.send(message);
    for (let attempt = 2; attempt <= 5; attempt++) {
      expect(
        (await h.redis.xPendingRange(stream, group, entryId, entryId, 1))[0]
          ?.deliveriesCounter,
      ).toBe(attempt - 1);
      expect(await h.redis.xLen(dead)).toBe(0);
      await h.redis.sendCommand([
        'XCLAIM',
        stream,
        group,
        'consumer-A',
        '0',
        entryId,
        'IDLE',
        '30001',
        'JUSTID',
      ]);
      await h.consumer.pollOnce();
    }
    await noPending();
    expect(moderate).toHaveBeenCalledTimes(5);
    expect((await h.redis.xRange(dead, '-', '+'))[0]?.message).toMatchObject({
      streamId: entryId,
      eventId: message.eventId,
      data: message.data,
      error: 'Error: provider unavailable',
    });
  });

  it('uses injected clock, guarantees first hour and atomically publishes one event under concurrent scans', async () => {
    const young = h.postId();
    const old = h.postId();
    await h.lifecycle.initialize(young, '2026-01-01T01:01:00.000Z');
    await h.lifecycle.initialize(old, start);
    const schedulers = [
      new LifecycleScheduler(h.lifecycle, { now: () => now }),
      new LifecycleScheduler(h.lifecycle, { now: () => now }),
    ];
    // 두 scanner가 같은 version을 읽은 뒤 CAS하도록 순서를 고정한다.
    const find = h.repository.find.bind(h.repository);
    let release!: () => void;
    let reads = 0;
    let barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(h.repository, 'find')
      .mockImplementation(async (postId) => {
        const projection = await find(postId);
        if (postId === old && reads < 2) {
          if (++reads === 2) release();
          await barrier;
        }
        return projection;
      });
    await Promise.all(schedulers.map((s) => s.scan()));
    expect(reads).toBe(2);
    await schedulers[0]!.scan();
    expect(await h.repository.find(young)).toMatchObject({
      state: 'ACTIVE',
      version: 0,
    });
    expect(await h.repository.find(old)).toMatchObject({
      state: 'STALE',
      staleAt: now.toISOString(),
      version: 1,
    });
    expect((await events()).map((e) => e.eventType)).toEqual(['BOARD_STALE']);
    const later = new Date('2026-01-01T02:10:00.000Z');
    // 새로운 ACTIVE가 임계점을 넘지 않도록 이 경우는 같은 old post만 CAS 경쟁시킨다.
    reads = 0;
    barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Promise.all([
      h.lifecycle.evaluate(old, later),
      h.lifecycle.evaluate(old, later),
    ]);
    expect(reads).toBe(2);
    spy.mockRestore();
    await h.lifecycle.evaluate(old, later);
    expect(await h.repository.find(old)).toMatchObject({
      state: 'CLOSED',
      version: 2,
    });
    expect((await events()).map((e) => e.eventType)).toEqual([
      'BOARD_STALE',
      'BOARD_CLOSED',
    ]);
  });

  it('does not ACK a duplicate while its original event is still processing', async () => {
    await h.prepare();
    const id = h.postId();
    const message = h.fields('PostCreated', id, start);
    await h.redis.set(`moderation:dedup:${message.eventId}`, 'processing', {
      EX: 30,
    });
    const entryId = await h.send(message);
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    expect(await h.repository.find(id)).toBeNull();
    await h.redis.del(`moderation:dedup:${message.eventId}`);
    await h.redis.sendCommand([
      'XCLAIM',
      stream,
      group,
      'consumer-A',
      '0',
      entryId,
      'IDLE',
      '30001',
      'JUSTID',
    ]);
    await h.consumer.pollOnce();
    expect(await h.repository.find(id)).toMatchObject({
      state: 'ACTIVE',
      version: 0,
    });
    await noPending();
  });
});
