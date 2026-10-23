import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dead, group, redisHarness, stream } from './redis-harness.js';

const at = '2026-01-01T00:01:00.000Z';
const result = {
  flagged: false,
  categories: {},
  categoryScores: {},
  model: 'omni-moderation-latest',
};
describe('consumer ownership and shutdown with real Redis', () => {
  let h: Awaited<ReturnType<typeof redisHarness>>;
  const moderate = vi.fn();
  beforeEach(async () => {
    moderate.mockReset().mockResolvedValue(result);
    h = await redisHarness({ moderate });
    await h.prepare();
  });
  afterEach(async () => {
    if (h?.redis.isOpen) await h.cleanup();
  });
  async function message() {
    const id = h.postId();
    await h.lifecycle.initialize(id, '2026-01-01T00:00:00.000Z');
    return h.fields('PostCommentCreated', id, at);
  }
  it.each([true, false])(
    'does not overwrite/release a successor lease (provider succeeds=%s)',
    async (succeeds) => {
      const fields = await message();
      const entryId = await h.redis.xAdd(stream, '*', fields);
      await h.redis.xReadGroup(group, 'worker-original', {
        key: stream,
        id: '>',
      });
      let started!: () => void, finish!: () => void;
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const paused = new Promise<void>((r) => {
        finish = r;
      });
      moderate.mockImplementationOnce(async () => {
        started();
        await paused;
        if (!succeeds) throw new Error('temporary');
        return result;
      });
      const processing = h.consumer.process({ id: entryId, message: fields });
      await entered;
      // TTL 만료 후 다른 worker가 획득한 상태를 재현한다. 실제로 30초를 기다리지 않는다.
      await h.redis.set(`moderation:dedup:${fields.eventId}`, 'successor', {
        EX: 30,
      });
      finish();
      await processing;
      expect(await h.redis.get(`moderation:dedup:${fields.eventId}`)).toBe(
        'successor',
      );
      expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    },
  );
  it('leaves malformed input pending when DLQ persistence fails', async () => {
    const fields = await message();
    await h.redis.set(dead, 'wrong-type');
    await expect(h.send({ ...fields, data: '{' })).rejects.toThrow();
    expect((await h.redis.xPending(stream, group)).pending).toBe(1);
    expect(await h.redis.get(dead)).toBe('wrong-type');
  });
  it('finishes in-flight persistence and ACK before disconnecting on shutdown', async () => {
    const fields = await message();
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const paused = new Promise<void>((r) => {
      finish = r;
    });
    moderate.mockImplementationOnce(async () => {
      started();
      await paused;
      return result;
    });
    await h.redis.xAdd(stream, '*', fields);
    await h.consumer.onModuleInit();
    await entered;
    const stopping = h.consumer.onModuleDestroy();
    finish();
    await stopping;
    expect(await h.redis.get(`moderation:dedup:${fields.eventId}`)).toBe(
      'done',
    );
    expect((await h.redis.xPending(stream, group)).pending).toBe(0);
    expect(await h.results.find(fields.eventId)).toMatchObject(result);
  });
});
