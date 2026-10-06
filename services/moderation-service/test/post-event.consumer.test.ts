import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { PostEventConsumer } from '../src/event-consumer/post-event.consumer.js';
import type { PostEventProcessor } from '../src/event-consumer/post-event.processor.js';
import { parsePostEvent } from '../src/event-consumer/post-event.js';

function fields(eventType: string, extra: Record<string, unknown> = {}) {
  const event = {
    eventId: 'evt_1',
    aggregateId: 'post_1',
    eventType,
    schemaVersion: 1,
    producer: 'post-service',
    correlationId: 'req_1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
  return { eventId: event.eventId, eventType, data: JSON.stringify(event) };
}

function setup(process = vi.fn().mockResolvedValue(undefined)) {
  const values = new Map<string, string>();
  const redis = {
    isOpen: true,
    on: vi.fn(),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(
      async (key: string, value: string, options?: { NX?: boolean }) => {
        if (options?.NX && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
    ),
    del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
    xAck: vi.fn().mockResolvedValue(1),
    xAdd: vi.fn().mockResolvedValue('9-0'),
    xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: 1 }]),
    xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
    xReadGroup: vi.fn().mockResolvedValue(null),
  };
  const processor: PostEventProcessor = { process };
  const consumer = new PostEventConsumer(
    new ConfigService(),
    processor,
    redis as never,
  );
  return { consumer, redis, process };
}

describe('Post event contract', () => {
  it('parses current PostCreated and PostCommentCreated payloads', () => {
    expect(
      parsePostEvent(fields('PostCreated', { post: { postId: 'post_1' } })),
    ).toMatchObject({ eventType: 'PostCreated' });
    expect(
      parsePostEvent(
        fields('PostCommentCreated', {
          comment: {
            commentId: 'comment_1',
            postId: 'post_1',
            authorId: 1,
            content: 'hello',
          },
        }),
      ),
    ).toMatchObject({ comment: { content: 'hello' } });
  });

  it('recognizes reaction and participant events and rejects producer/schema errors', () => {
    expect(parsePostEvent(fields('PostReactionCreated'))).toMatchObject({
      eventType: 'PostReactionCreated',
    });
    expect(parsePostEvent(fields('PostParticipantJoined'))).toMatchObject({
      eventType: 'PostParticipantJoined',
    });
    expect(() =>
      parsePostEvent(
        fields('PostCreated', {
          producer: 'other',
          post: { postId: 'post_1' },
        }),
      ),
    ).toThrow('Invalid post event envelope');
    expect(() =>
      parsePostEvent(
        fields('PostCreated', { schemaVersion: 2, post: { postId: 'post_1' } }),
      ),
    ).toThrow('Invalid post event envelope');
    expect(() =>
      parsePostEvent({ eventId: 'evt_1', eventType: 'PostCreated', data: '{' }),
    ).toThrow('Invalid post event JSON');
  });
});

describe('PostEventConsumer', () => {
  it('ACKs successful processing and deduplicates the same eventId', async () => {
    const { consumer, redis, process } = setup();
    const entry = {
      id: '1-0',
      message: fields('PostCreated', { post: { postId: 'post_1' } }),
    };
    await consumer.process(entry);
    await consumer.process({ ...entry, id: '2-0' });
    expect(process).toHaveBeenCalledOnce();
    expect(redis.xAck).toHaveBeenCalledTimes(2);
  });

  it('does not ACK a retriable processing failure', async () => {
    const { consumer, redis } = setup(
      vi.fn().mockRejectedValue(new Error('temporary')),
    );
    await consumer.process({
      id: '1-0',
      message: fields('PostCreated', { post: { postId: 'post_1' } }),
    });
    expect(redis.xAck).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalled();
  });

  it('dead-letters malformed events before ACK', async () => {
    const { consumer, redis } = setup();
    await consumer.process({
      id: '1-0',
      message: { eventId: 'evt_1', eventType: 'PostCreated', data: '{' },
    });
    expect(redis.xAdd).toHaveBeenCalledOnce();
    expect(redis.xAdd.mock.invocationCallOrder[0]).toBeLessThan(
      redis.xAck.mock.invocationCallOrder[0]!,
    );
  });

  it('recovers pending entries with XAUTOCLAIM', async () => {
    const { consumer, redis, process } = setup();
    redis.xAutoClaim.mockResolvedValueOnce({
      messages: [
        {
          id: '1-0',
          message: fields('PostCreated', { post: { postId: 'post_1' } }),
        },
      ],
    });
    await consumer.pollOnce();
    expect(process).toHaveBeenCalledOnce();
    expect(redis.xAck).toHaveBeenCalledOnce();
  });
});
