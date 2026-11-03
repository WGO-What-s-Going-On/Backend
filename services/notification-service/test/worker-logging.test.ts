import 'reflect-metadata';
import type { createClient } from 'redis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableStreamConsumer } from '../src/event-consumer/durable-stream.consumer.js';
import type { PostgresDatabase } from '../src/persistence/postgres.database.js';
import { getLogContext } from '../src/observability/logging.js';
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
