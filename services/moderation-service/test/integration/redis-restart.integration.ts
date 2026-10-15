import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { expect, it } from 'vitest';
import { PostEventConsumer } from '../../src/event-consumer/post-event.consumer.js';
import { group, output, redisHarness, stream } from './redis-harness.js';

// 컨테이너를 재시작하므로 전용 로컬 Redis에서 명시적으로 선택한 경우에만 실행한다.
it.skipIf(process.env.MODERATION_REDIS_RESTART_TEST !== '1')(
  'recovers snapshot, CAS output, dedup and PEL after a checkpointed compose Redis restart',
  async () => {
    const url =
      process.env.MODERATION_TEST_REDIS_URL ?? 'redis://localhost:6383/15';
    expect(url).toBe('redis://localhost:6383/15');
    const at = (m: number) =>
      new Date(Date.UTC(2026, 0, 1) + m * 60_000).toISOString();
    const h = await redisHarness(
      {
        moderate: async () => {
          throw new Error('not used');
        },
      },
      { now: () => new Date(at(10)) },
    );
    let restarted: PostEventConsumer | undefined;
    let checkpointed = false;
    try {
      const databases = (await h.redis.info('keyspace'))
        .split('\r\n')
        .filter((line) => /^db\d+:/.test(line));
      expect(databases).toEqual([]); // 다른 DB에 데이터가 있다면 재시작하지 않는다.
      await h.prepare();
      const id = h.postId();
      const created = h.fields('PostCreated', id, at(0));
      await h.send(created);
      for (let userId = 1; userId <= 5; userId++)
        await h.lifecycle.recordReaction(
          id,
          { userId, type: 'ENDED', version: 1, active: true, createdAt: at(9) },
          at(10),
          'req_restart',
          new Date(at(10)),
        );
      const before = await h.repository.find(id);
      const pending = h.fields('PostCreated', id, at(0));
      const entryId = await h.redis.xAdd(stream, '*', pending);
      await h.redis.xReadGroup(group, 'worker-before-restart', {
        key: stream,
        id: '>',
      });
      await h.consumer.onModuleDestroy();
      await h.repository.onModuleDestroy();
      await h.results.onModuleDestroy();
      await h.redis.sendCommand(['SAVE']);
      checkpointed = true;
      await h.redis.quit();
      execFileSync(
        'docker',
        ['compose', '--profile', 'redis', 'restart', 'redis'],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          timeout: 15_000,
          stdio: 'pipe',
          windowsHide: true,
        },
      );
      // 재시작 완료는 ready 상태로 확인하며 실제 정책의 10분을 기다리지 않는다.
      for (let attempt = 0; ; attempt++) {
        try {
          await h.redis.connect();
          break;
        } catch (error) {
          if (attempt >= 20) throw error;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(await h.repository.find(id)).toEqual(before);
      expect(await h.redis.get(`moderation:dedup:${created.eventId}`)).toBe(
        'done',
      );
      expect((await h.redis.xPending(stream, group)).pending).toBe(1);
      await h.redis.sendCommand([
        'XCLAIM',
        stream,
        group,
        'worker-before-restart',
        '0',
        entryId,
        'IDLE',
        '30001',
        'JUSTID',
      ]);
      const connection = createClient({
        url,
        socket: { reconnectStrategy: false },
      });
      restarted = new PostEventConsumer(
        new ConfigService({ redis: { url } }),
        h.processor,
        connection,
      );
      await restarted.onModuleInit();
      await expect
        .poll(() => h.redis.get(`moderation:dedup:${pending.eventId}`))
        .toBe('done');
      await expect
        .poll(async () => (await h.redis.xPending(stream, group)).pending)
        .toBe(0);
      await restarted.onModuleDestroy();
      await h.lifecycle.evaluate(id, new Date(at(20)));
      expect((await h.repository.find(id))?.state).toBe('CLOSED');
      expect(
        (await h.redis.xRange(output, '-', '+')).map(
          (e) => e.message.eventType,
        ),
      ).toEqual(['BOARD_STALE', 'BOARD_CLOSED']);
    } finally {
      await restarted?.onModuleDestroy();
      if (!h.redis.isOpen) await h.redis.connect();
      await h.cleanup();
      // 테스트 전용 checkpoint에서도 소유 key를 제거한 결과를 저장한다.
      if (checkpointed) {
        const cleanup = createClient({ url });
        cleanup.on('error', () => undefined);
        await cleanup.connect();
        try {
          await cleanup.sendCommand(['SAVE']);
        } finally {
          await cleanup.quit();
        }
      }
    }
  },
  30_000,
);
