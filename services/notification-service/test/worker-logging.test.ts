import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import type { createClient } from 'redis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableStreamConsumer } from '../src/event-consumer/durable-stream.consumer.js';
import type { PostgresDatabase } from '../src/persistence/postgres.database.js';
import { getLogContext } from '../src/observability/logging.js';
import { PostEventHandler } from '../src/event-consumer/post-event.handler.js';
import type { PostgresEventStore } from '../src/persistence/postgres-event.store.js';
import type { NotificationState } from '../src/redis/notification-state.js';
afterEach(() => vi.restoreAllMocks());
describe('durable notification stream logging', () => {
  it.each(['success', 'retry', 'dead', 'ack-failure'] as const)(
    'records %s without leaking source payloads',
    async (scenario) => {
      const lines: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(
        (line: string | Uint8Array) => {
          lines.push(String(line));
          return true;
        },
      );
      const redis = {
        on: vi.fn(),
        xPendingRange: vi
          .fn()
          .mockResolvedValue([
            { deliveriesCounter: scenario === 'dead' ? 5 : 1 },
          ]),
        eval: vi.fn().mockResolvedValue(1),
        xAck: vi.fn().mockImplementation(async () => {
          if (scenario === 'ack-failure')
            throw new Error('private Redis credentials');
        }),
      };
      const worker = new DurableStreamConsumer(
        {} as PostgresDatabase,
        {
          url: 'redis://localhost',
          stream: 'user:events',
          group: 'user-notification',
          dead: 'notification:user:dead',
        },
        async () => {
          expect(getLogContext().correlationId).toBe('correlation-1');
          if (scenario === 'retry' || scenario === 'dead')
            throw new Error('private payload from provider');
        },
        redis as unknown as ReturnType<typeof createClient>,
      );
      const entry = {
        id: '1-0',
        message: {
          eventId: 'event-1',
          data: JSON.stringify({
            correlationId: 'correlation-1',
            body: 'private event body',
          }),
        },
      };
      if (scenario === 'ack-failure')
        await expect(worker.process(entry)).rejects.toThrow();
      else await worker.process(entry);
      const records = lines.map((line) => JSON.parse(line));
      expect(
        records.every(
          (record) =>
            record.service === 'notification-service' &&
            record.correlationId === 'correlation-1',
        ),
      ).toBe(true);
      expect(
        records.some(
          (record) => record.event === 'notification_event_acknowledged',
        ),
      ).toBe(scenario === 'success');
      expect(
        records.some(
          (record) => record.event === 'notification_event_dead_lettered',
        ),
      ).toBe(scenario === 'dead');
      if (scenario === 'retry' || scenario === 'dead')
        expect(
          records.find((record) => record.event === 'notification_event_failed')
            ?.error.retryable,
        ).toBe(scenario === 'retry');
      expect(redis.eval).toHaveBeenCalledTimes(scenario === 'dead' ? 1 : 0);
      expect(lines.join('')).not.toMatch(
        /private event body|private payload from provider|private Redis credentials/,
      );
    },
  );
});

describe('push delivery logging', () => {
  it('keeps ingesting events without acquiring delivery jobs while push is paused', async () => {
    const apply = vi.fn().mockResolvedValue('1');
    const deliveries = vi.fn();
    const invalidateUnread = vi.fn();
    const send = vi.fn();
    const handler = new PostEventHandler(
      { apply, deliveries } as unknown as PostgresEventStore,
      { invalidateUnread } as unknown as NotificationState,
      { send },
      new ConfigService({ NOTIFICATION_PUSH_DELIVERY_ENABLED: 'false' }),
    );
    const event = { aggregateId: 'post-1' } as Parameters<
      typeof handler.handle
    >[0];
    await handler.handle(event);
    await handler.drain();
    expect(apply).toHaveBeenCalledWith(event);
    expect(invalidateUnread).toHaveBeenCalledWith('1');
    expect(deliveries).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      invalidTokens: [],
      outcome: 'NO_TOKENS',
    },
    {
      attempted: 1,
      succeeded: 0,
      failed: 1,
      invalidTokens: ['private-test-token'],
      outcome: 'INVALID_TOKENS',
    },
    {
      attempted: 1,
      succeeded: 1,
      failed: 0,
      invalidTokens: [],
      outcome: 'accepted',
    },
  ])(
    'distinguishes $outcome from a device receipt',
    async ({ outcome, ...result }) => {
      const lines: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
        lines.push(String(line));
        return true;
      });
      const delivery = {
        attempts: 1,
        postId: 'post-1',
        message: { userId: '1', title: 'title', body: 'private test body' },
      };
      const finish = vi.fn();
      const store = {
        deliveries: async () => [delivery],
        acquire: async () => delivery,
        finish,
      } as unknown as PostgresEventStore;
      const handler = new PostEventHandler(store, {} as NotificationState, {
        send: async () => result,
      });
      await handler.dispatch();
      expect(finish).toHaveBeenCalledWith(delivery, 'SENT');
      expect(JSON.parse(lines[0]!)).toMatchObject({
        event:
          outcome === 'accepted'
            ? 'push_delivery_sent'
            : 'push_delivery_skipped',
        count: result.attempted,
        delivered: result.succeeded,
        failed: result.failed,
        ...(outcome === 'accepted' ? {} : { reasonCode: outcome }),
      });
      expect(lines.join('')).not.toMatch(
        /private test body|private-test-token/,
      );
    },
  );
});
