import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PostNotFoundError } from '../src/post/domain/post.js';
import { ModerationConsumer } from '../src/post/infrastructure/moderation-consumer.js';

function setup(error?: Error, attempt = 1) {
  const eventId = `evt_${randomUUID()}`;
  const postId = `post_${randomUUID()}`;
  const entry = {
    id: '123-0',
    message: {
      eventId,
      eventType: 'BOARD_CLOSED',
      data: JSON.stringify({
        eventId,
        aggregateId: postId,
        eventType: 'BOARD_CLOSED',
        schemaVersion: 1,
        producer: 'moderation-service',
        correlationId: 'req-logging',
        occurredAt: new Date().toISOString(),
        payload: { postId, state: 'CLOSED' },
      }),
    },
  };
  const commands = {
    xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: attempt }]),
    xAdd: vi.fn().mockResolvedValue('456-0'),
    xAck: vi.fn().mockResolvedValue(1),
  };
  const redis = {
    withCommandOptions: () => commands,
  } as unknown as ConstructorParameters<typeof ModerationConsumer>[0];
  const application = {
    execute: error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(undefined),
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const consumer = new ModerationConsumer(
    redis,
    application,
    30000,
    'moderation:events',
    logger,
  );
  return { consumer, entry, logger, commands, application, eventId, postId };
}

describe('Moderation structured failure logs', () => {
  it('logs missing targets as retry with correlation and actual delivery count', async () => {
    const t = setup(new PostNotFoundError('private details'), 2);
    await t.consumer.process(t.entry);
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'moderation_event_retry',
        errorCode: 'POST_NOT_FOUND',
        attempt: 2,
        disposition: 'RETRY',
        eventId: t.eventId,
        postId: t.postId,
        correlationId: 'req-logging',
        streamId: '123-0',
      }),
    );
    expect(t.commands.xAck).not.toHaveBeenCalled();
    expect(JSON.stringify(t.logger.warn.mock.calls)).not.toContain(
      'private details',
    );
  });
  it('separates retry exhaustion from the failure cause without exposing DB credentials', async () => {
    const t = setup(new Error('mongodb://admin:secret@db private content'), 5);
    await t.consumer.process(t.entry);
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'moderation_event_dead_lettered',
        errorCode: 'PROCESSING_FAILED',
        reason: 'RETRY_EXHAUSTED',
        attempt: 5,
        disposition: 'DLQ',
      }),
    );
    expect(JSON.stringify(t.logger.warn.mock.calls)).not.toMatch(
      /secret|private content|mongodb/,
    );
    expect(t.commands.xAck).toHaveBeenCalledOnce();
  });
  it('does not leak malformed payload or arbitrary wire IDs', async () => {
    const t = setup();
    t.entry.message.data = '{"token":"private-token"}';
    t.entry.message.eventId = 'Bearer private-token';
    await t.consumer.process(t.entry);
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'INVALID_CONTRACT',
        disposition: 'DLQ',
      }),
    );
    expect(JSON.stringify(t.logger.warn.mock.calls)).not.toContain(
      'private-token',
    );
    expect(t.application.execute).not.toHaveBeenCalled();
  });
  it('logs DLQ write failure without falsely logging quarantine or acknowledging', async () => {
    const t = setup(new PostNotFoundError('missing'), 5);
    t.commands.xAdd.mockRejectedValue(new Error('secret Redis error'));
    await expect(t.consumer.process(t.entry)).rejects.toThrow();
    expect(t.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'DLQ_WRITE_FAILED',
        causeCode: 'POST_NOT_FOUND',
        disposition: 'RETRY',
      }),
    );
    expect(t.logger.warn).not.toHaveBeenCalled();
    expect(t.commands.xAck).not.toHaveBeenCalled();
  });
  it('logs pending lookup failure without fabricating an attempt count', async () => {
    const t = setup(new Error('private error'));
    t.commands.xPendingRange.mockRejectedValue(new Error('unavailable'));
    await expect(t.consumer.process(t.entry)).rejects.toThrow();
    expect(t.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'PENDING_LOOKUP_FAILED',
        causeCode: 'PROCESSING_FAILED',
        attempt: null,
      }),
    );
    expect(t.commands.xAck).not.toHaveBeenCalled();
  });
  it('logs ACK failure separately after successful processing', async () => {
    const t = setup();
    t.commands.xAck.mockRejectedValue(new Error('private Redis error'));
    await expect(t.consumer.process(t.entry)).rejects.toThrow();
    expect(t.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'moderation_event_ack_failed',
        errorCode: 'ACK_FAILED',
        disposition: 'RETRY',
      }),
    );
    expect(t.commands.xAdd).not.toHaveBeenCalled();
  });
  it('keeps successful processing quiet', async () => {
    const t = setup();
    await t.consumer.process(t.entry);
    expect(t.logger.warn).not.toHaveBeenCalled();
    expect(t.logger.error).not.toHaveBeenCalled();
  });
  it('renders one-line JSON suitable for log collection', () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      new ConsoleLogger('ModerationConsumer', { json: true }).warn({
        event: 'moderation_event_retry',
        errorCode: 'POST_NOT_FOUND',
      });
      const output = write.mock.calls.map((call) => String(call[0])).join('');
      expect(output.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(output).message.errorCode).toBe('POST_NOT_FOUND');
    } finally {
      write.mockRestore();
    }
  });
});
