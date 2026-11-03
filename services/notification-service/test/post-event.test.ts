import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import {
  parsePostEvent,
  type SupportedPostEventType,
} from '../src/event-consumer/post-event.js';
import { PostEventConsumer } from '../src/event-consumer/post-event.consumer.js';
import { PostEventHandler } from '../src/event-consumer/post-event.handler.js';
import { BusyDeliveryError } from '../src/persistence/postgres-event.store.js';
import { wire } from './helpers/post-events.js';
import type { PostgresDatabase } from '../src/persistence/postgres.database.js';
const types: SupportedPostEventType[] = [
  'PostCreated',
  'PostCommentCreated',
  'PostReactionCreated',
  'PostParticipantJoined',
  'PostReactionRemoved',
  'PostCommentDeleted',
  'PostDeleted',
  'PostParticipantLeft',
  'PostExpired',
];
describe('actual Post v1 wire contract', () => {
  it.each(types)('recognizes %s', (type) => {
    const fields = wire(type);
    expect(parsePostEvent(fields.data, fields)).toMatchObject({
      eventType: type,
      producer: 'post-service',
    });
  });
  it.each(['CURIOUS', 'STILL_HAPPENING', 'HELPFUL', 'ENDED', 'LIKE'])(
    'supports reaction %s including legacy replay',
    (reactionType) => {
      expect(
        parsePostEvent(wire('PostReactionCreated', { reactionType }).data)
          ?.actorId,
      ).toBe('2');
    },
  );
  it('accepts missing additive legacy fields without guessing a recipient', () => {
    const parsed = parsePostEvent(
      wire('PostCommentCreated', { legacy: true }).data,
    )!;
    expect(parsed.postAuthorId).toBeUndefined();
    expect(parsed.activityVersion).toBeUndefined();
  });
  it.each([0, -1, '2', 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid user ID %s',
    (bad) => {
      const data = JSON.parse(wire('PostCommentCreated').data);
      data.postAuthorId = bad;
      expect(() => parsePostEvent(JSON.stringify(data))).toThrow('Invalid');
    },
  );
  it('rejects mismatched stream identifiers, producer, schema, domain IDs and malformed payloads', () => {
    const fields = wire('PostCommentCreated');
    expect(() =>
      parsePostEvent(fields.data, { ...fields, eventId: 'other' }),
    ).toThrow('Invalid');
    for (const override of [
      { producer: 'other' },
      { schemaVersion: 2 },
      { correlationId: '' },
      { comment: { authorId: 2 } },
      { occurredAt: 'bad' },
    ])
      expect(() =>
        parsePostEvent(
          JSON.stringify({ ...JSON.parse(fields.data), ...override }),
        ),
      ).toThrow('Invalid');
    expect(() => parsePostEvent('{')).toThrow('Invalid post event JSON');
    expect(() => parsePostEvent('null')).toThrow('Invalid');
    expect(() => parsePostEvent('{"eventType":"FutureEvent"}')).toThrow(
      'Invalid',
    );
    expect(
      parsePostEvent(
        JSON.stringify({
          ...JSON.parse(fields.data),
          eventType: 'FutureEvent',
        }),
      ),
    ).toBeNull();
  });
  it('distinguishes user deletion from Moderation deletion', () => {
    expect(
      parsePostEvent(wire('PostCommentDeleted', { moderation: true }).data),
    ).toMatchObject({
      reason: 'MODERATION_VIOLATION',
      actorType: 'MODERATION',
    });
  });
});
describe('PostEventConsumer ACK policy', () => {
  function setup(error?: Error) {
    const handler = {
      ignore: vi.fn().mockResolvedValue(undefined),
      handle: error
        ? vi.fn().mockRejectedValue(error)
        : vi.fn().mockResolvedValue(undefined),
    } as unknown as PostEventHandler;
    const redis = {
      on: vi.fn(),
      xAck: vi.fn().mockResolvedValue(1),
      eval: vi.fn().mockResolvedValue(1),
      xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: 1 }]),
    };
    const consumer = new PostEventConsumer(
      new ConfigService(),
      handler,
      redis as never,
      {} as PostgresDatabase,
    );
    return { consumer, redis, handler };
  }
  it('ACKs unsupported events, but dead-letters malformed supported events before ACK', async () => {
    const { consumer, redis, handler } = setup();
    await consumer.process({
      id: '1-0',
      message: {
        ...wire('PostCreated'),
        eventType: 'FutureEvent',
        data: JSON.stringify({
          ...JSON.parse(wire('PostCreated').data),
          eventId: 'evt_future',
          eventType: 'FutureEvent',
        }),
        eventId: 'evt_future',
      },
    });
    await consumer.process({ id: '2-0', message: { data: '{' } });
    expect(redis.xAck).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledOnce();
    expect(handler.ignore).toHaveBeenCalledOnce();
  });
  it.each([new Error('temporary'), new BusyDeliveryError()])(
    'does not ACK unfinished work',
    async (error) => {
      const { consumer, redis } = setup(error);
      await consumer.process({
        id: '1-0',
        message: wire('PostCommentCreated'),
      });
      expect(redis.xAck).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    },
  );
  it('does not ACK if DLQ storage fails', async () => {
    const { consumer, redis } = setup();
    redis.eval.mockRejectedValue(new Error('DLQ unavailable'));
    await expect(
      consumer.process({ id: '1-0', message: { data: '{' } }),
    ).rejects.toThrow('DLQ unavailable');
    expect(redis.xAck).not.toHaveBeenCalled();
  });
});
