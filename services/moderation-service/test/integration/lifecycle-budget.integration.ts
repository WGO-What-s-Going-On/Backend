import { expect, it } from 'vitest';
import { redisHarness } from './redis-harness.js';
import type { LifecycleProjection } from '../../src/lifecycle/lifecycle.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
it('claims bounded disjoint due batches, recovers abandoned leases and excludes future/closed posts', async () => {
  const h = await redisHarness({
    moderate: async () => {
      throw new Error('unused');
    },
  });
  try {
    await h.repository.ready();
    const now = new Date('2026-01-01T02:00:00.000Z');
    const old: string[] = [],
      future: string[] = [];
    for (let i = 0; i < 250; i++) {
      const id = h.postId();
      old.push(id);
      await h.lifecycle.initialize(id, '2026-01-01T00:00:00.000Z');
    }
    for (let i = 0; i < 20; i++) {
      const id = h.postId();
      future.push(id);
      await h.lifecycle.initialize(id, '2026-01-01T01:59:00.000Z');
    }
    const started = performance.now();
    const [first, second] = await Promise.all([
      h.lifecycle.due(now),
      h.lifecycle.due(now),
    ]);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(new Set([...first, ...second]).size).toBe(200);
    expect(await h.lifecycle.due(now)).toHaveLength(50);
    expect(await h.lifecycle.due(now)).toEqual([]);
    expect(
      (await h.lifecycle.due(new Date(now.getTime() + 60_001))).every(
        (id) => old.includes(id) && !future.includes(id),
      ),
    ).toBe(true);
    await h.lifecycle.terminate(
      old[0]!,
      'DELETED',
      2,
      now.toISOString(),
      'req_close',
    );
    expect(
      await h.redis.zScore('moderation:lifecycle:due', old[0]!),
    ).toBeNull();
    console.info(
      JSON.stringify({
        measurement: 'lifecycle_due_batch',
        active: 270,
        due: 250,
        batchLimit: 100,
        claimed: 250,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  } finally {
    await h.cleanup();
  }
});
it('fails closed on an unbackfilled due index and preflights index types before projection writes', async () => {
  const h = await redisHarness({
    moderate: async () => {
      throw new Error('unused');
    },
  });
  try {
    const id = h.postId();
    await h.lifecycle.initialize(id, '2026-01-01T00:00:00.000Z');
    await h.redis.del('moderation:lifecycle:due');
    await expect(h.lifecycle.due(new Date())).rejects.toThrow(
      'requires migration',
    );
    const before = await h.repository.find(id);
    const env = {
      ...process.env,
      REDIS_URL:
        process.env.MODERATION_TEST_REDIS_URL ?? 'redis://localhost:6383/15',
    };
    const command = promisify(execFile);
    const dry = await command(
      process.execPath,
      ['scripts/migrate-lifecycle-due.mjs'],
      { env, windowsHide: true },
    );
    expect(JSON.parse(dry.stdout)).toMatchObject({
      mode: 'dry-run',
      inspected: 1,
      migrated: 0,
    });
    expect(await h.redis.zCard('moderation:lifecycle:due')).toBe(0);
    const applied = await command(
      process.execPath,
      ['scripts/migrate-lifecycle-due.mjs', '--apply'],
      { env, windowsHide: true },
    );
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: 'apply',
      inspected: 1,
      migrated: 1,
      conflicts: 0,
    });
    expect(await h.repository.ready()).toBe(true);
    expect(await h.repository.find(id)).toEqual(before);
    await h.redis.del('moderation:lifecycle:due');
    await h.redis.set('moderation:lifecycle:due', 'wrong-type');
    const missing = h.postId();
    await expect(
      h.lifecycle.initialize(missing, '2026-01-01T00:00:00.000Z'),
    ).rejects.toThrow();
    expect(await h.repository.find(missing)).toBeNull();
  } finally {
    await h.cleanup();
  }
});
it('compacts relation state only after CLOSED while preserving terminal identity and audit summary', async () => {
  const h = await redisHarness({
    moderate: async () => {
      throw new Error('unused');
    },
  });
  try {
    const postId = h.postId();
    const projection: LifecycleProjection = {
      postId,
      state: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastMeaningfulActivityAt: '2026-01-01T00:00:00.000Z',
      staleAt: null,
      version: 0,
      reactionHistoryComplete: true,
      reactions: Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [
          `${i + 1}:CURIOUS`,
          {
            userId: i + 1,
            type: 'CURIOUS',
            version: 1,
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
      comments: Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [
          `c_${i}`,
          { version: 2, deleted: true },
        ]),
      ),
    };
    await h.repository.create(projection);
    const before = Buffer.byteLength(JSON.stringify(projection));
    const started = performance.now();
    await h.lifecycle.evaluate(postId, new Date('2026-01-01T02:00:00.000Z'));
    await h.lifecycle.evaluate(postId, new Date('2026-01-01T02:10:00.000Z'));
    const closed = await h.repository.find(postId);
    expect(closed).toMatchObject({
      postId,
      state: 'CLOSED',
      staleReason: 'INACTIVITY',
      version: 2,
    });
    expect(closed!.reactions).toBeUndefined();
    expect(closed!.comments).toBeUndefined();
    const after = Buffer.byteLength(JSON.stringify(closed));
    expect(after).toBeLessThan(before / 10);
    console.info(
      JSON.stringify({
        measurement: 'closed_projection_compaction',
        reactionRelations: 2000,
        commentTombstones: 2000,
        beforeBytes: before,
        afterBytes: after,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  } finally {
    await h.cleanup();
  }
});
