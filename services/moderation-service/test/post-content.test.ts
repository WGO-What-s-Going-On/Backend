import { describe, expect, it, vi } from 'vitest';
import { parsePostEvent } from '../src/event-consumer/post-event.js';
import { ModerationPostEventProcessor } from '../src/event-consumer/moderation-post-event.processor.js';
import type { ContentModerationService } from '../src/content-moderation/content-moderation.service.js';
import type { LifecycleService } from '../src/lifecycle/lifecycle.service.js';

function fields(
  eventType: string,
  post: Record<string, unknown> = {},
  version: unknown = 2,
) {
  return {
    eventId: 'evt_1',
    eventType,
    data: JSON.stringify({
      eventId: 'evt_1',
      eventType,
      schemaVersion: 1,
      producer: 'post-service',
      aggregateId: 'post_1',
      correlationId: 'req_1',
      occurredAt: '2026-11-09T00:00:00.000Z',
      postVersion: version,
      post: {
        postId: 'post_1',
        authorId: 42,
        title: 'Title',
        content: 'Body',
        ...post,
      },
    }),
  };
}

describe('post content snapshots', () => {
  it.each(['PostCreated', 'PostUpdated'])(
    'evaluates %s title and body at the source version',
    async (type) => {
      const moderate = vi.fn();
      const initialize = vi.fn();
      const event = parsePostEvent(fields(type));
      expect(event).not.toBeNull();
      await new ModerationPostEventProcessor(
        { moderate } as unknown as ContentModerationService,
        { initialize } as unknown as LifecycleService,
      ).process(event!);
      expect(moderate).toHaveBeenCalledWith({
        targetType: 'POST',
        eventId: 'evt_1',
        postId: 'post_1',
        authorId: 42,
        correlationId: 'req_1',
        title: 'Title',
        content: 'Body',
        postVersion: 2,
      });
      expect(initialize).toHaveBeenCalledTimes(type === 'PostCreated' ? 1 : 0);
    },
  );
});

it.each([
  { title: undefined },
  { content: undefined },
  { title: null },
  { content: '' },
  { title: 'a'.repeat(121) },
  { content: 'a'.repeat(5001) },
  { authorId: undefined },
])('rejects incomplete or invalid post snapshots %j', (post) => {
  expect(() => parsePostEvent(fields('PostCreated', post))).toThrow(
    'Invalid post content snapshot',
  );
});
it.each([undefined, 0, -1, 1.5, '2'])(
  'rejects snapshot version %s',
  (version) => {
    const source = fields('PostUpdated');
    const value = JSON.parse(source.data);
    value.postVersion = version;
    expect(() =>
      parsePostEvent({ ...source, data: JSON.stringify(value) }),
    ).toThrow();
  },
);
it.each(['PostCreated', 'PostUpdated'])(
  'preserves legacy or state-only %s without fabricated content',
  async (type) => {
    const source = fields(type, { title: undefined, content: undefined });
    const value = JSON.parse(source.data);
    value.postContent = {
      title: 'forged',
      content: 'forged',
      authorId: 42,
      postVersion: 2,
    };
    const event = parsePostEvent({ ...source, data: JSON.stringify(value) });
    expect(event).not.toHaveProperty('postContent');
    const moderate = vi.fn();
    await new ModerationPostEventProcessor(
      { moderate } as unknown as ContentModerationService,
      { initialize: vi.fn() } as unknown as LifecycleService,
    ).process(event!);
    expect(moderate).not.toHaveBeenCalled();
  },
);
it('accepts the full text range admitted by Post creation', () => {
  expect(
    parsePostEvent(fields('PostCreated', { title: ' ', content: ' ' }))
      ?.postContent,
  ).toMatchObject({ title: ' ', content: ' ' });
});
