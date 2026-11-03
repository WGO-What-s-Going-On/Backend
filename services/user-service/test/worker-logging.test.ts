import { PostRewardsConsumer } from '../src/rewards/post-rewards.consumer.js';
import type { ActivityService } from '../src/rewards/activity.service.js';
import * as rewardEvents from '../src/rewards/post-event.js';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import type { RedisStreamsPublisher } from '../src/outbox/redis-streams.publisher.js';

afterEach(() => vi.restoreAllMocks());
describe('outbox commit logging', () => {
  it.each([false, true])(
    'emits publication success only after commit (rollback=%s)',
    async (rollback) => {
      const lines: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(
        (line: string | Uint8Array) => {
          lines.push(String(line));
          return true;
        },
      );
      const query = {
        where: vi.fn(),
        orderBy: vi.fn(),
        addOrderBy: vi.fn(),
        take: vi.fn(),
        setLock: vi.fn(),
        setOnLocked: vi.fn(),
        getMany: vi.fn(),
      };
      for (const name of [
        'where',
        'orderBy',
        'addOrderBy',
        'take',
        'setLock',
        'setOnLocked',
      ] as const)
        query[name].mockReturnValue(query);
      query.getMany.mockResolvedValue([
        {
          eventId: 'event-1',
          eventType: 'USER_WITHDRAWN',
          publishAttempts: 0,
          payload: {
            eventId: 'event-1',
            type: 'USER_WITHDRAWN',
            correlationId: 'correlation-1',
          },
        },
      ]);
      const manager = {
        getRepository: () => ({
          createQueryBuilder: () => query,
          update: vi.fn(),
        }),
      } as unknown as EntityManager;
      const database = {
        transaction: async (
          work: (manager: EntityManager) => Promise<unknown>,
        ) => {
          const result = await work(manager);
          expect(lines.some((line) => line.includes('outbox_published'))).toBe(
            false,
          );
          if (rollback) throw new Error('private connection credentials');
          return result;
        },
      } as unknown as DataSource;
      const publisher = {
        connect: vi.fn(),
        publish: vi.fn(),
        close: vi.fn(),
      } as unknown as RedisStreamsPublisher;
      const worker = new OutboxWorker(
        database,
        publisher,
        new ConfigService({ outbox: { pollIntervalMs: 1000, batchSize: 20 } }),
      );
      await worker.publishPending();
      const records = lines.map((line) => JSON.parse(line));
      expect(
        records.some((record) => record.event === 'outbox_published'),
      ).toBe(!rollback);
      if (rollback)
        expect(records).toContainEqual(
          expect.objectContaining({
            service: 'user-service',
            domain: 'outbox',
            outcome: 'failure',
            error: expect.objectContaining({ code: 'OUTBOX_BATCH_FAILED' }),
          }),
        );
      else
        expect(records).toContainEqual(
          expect.objectContaining({
            event: 'outbox_published',
            eventId: 'event-1',
            correlationId: 'correlation-1',
            outcome: 'success',
          }),
        );
      expect(lines.join('')).not.toContain('private connection credentials');
      await worker.onModuleDestroy();
    },
  );
});

describe('reward stream retry classification', () => {
  it.each([1, 5])(
    'records retry eligibility at attempt %s',
    async (attempt) => {
      const lines: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(
        (line: string | Uint8Array) => {
          lines.push(String(line));
          return true;
        },
      );
      vi.spyOn(rewardEvents, 'parsePostEvent').mockImplementation(() => {
        throw new Error('private reward failure');
      });
      const worker = new PostRewardsConsumer(
        new ConfigService({
          redis: { url: 'redis://localhost:6379' },
          rewards: { maxAttempts: 5 },
        }),
        {} as ActivityService,
      );
      vi.spyOn(worker.redis, 'xpending').mockResolvedValue([
        ['1-0', 'test', 0, attempt],
      ]);
      const quarantine = vi.spyOn(worker.redis, 'eval').mockResolvedValue(1);
      try {
        await worker.process(['1-0', ['eventId', 'event-1', 'data', '{}']]);
        const records = lines.map((line) => JSON.parse(line));
        expect(
          records.find((record) => record.event === 'reward_event_failed')
            ?.error.retryable,
        ).toBe(attempt < 5);
        expect(quarantine).toHaveBeenCalledTimes(attempt < 5 ? 0 : 1);
        expect(lines.join('')).not.toContain('private reward failure');
      } finally {
        await worker.onModuleDestroy();
      }
    },
  );
});
