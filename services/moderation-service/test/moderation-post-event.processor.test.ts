import { describe, expect, it, vi } from 'vitest';

import type { CommentModerationService } from '../src/content-moderation/comment-moderation.service.js';
import { ModerationPostEventProcessor } from '../src/event-consumer/moderation-post-event.processor.js';
import type { PostEvent } from '../src/event-consumer/post-event.js';
import type { LifecycleService } from '../src/lifecycle/lifecycle.service.js';

function event(eventType: PostEvent['eventType']): PostEvent {
  return {
    eventId: 'evt_1',
    aggregateId: 'post_1',
    eventType,
    schemaVersion: 1,
    producer: 'post-service',
    correlationId: 'req_1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...(eventType === 'PostCommentCreated'
      ? {
          comment: {
            commentId: 'comment_1',
            postId: 'post_1',
            authorId: 1,
            content: 'comment',
          },
        }
      : {}),
  };
}

describe('ModerationPostEventProcessor', () => {
  it('initializes lifecycle for PostCreated without moderating post content', async () => {
    const moderation = {
      moderate: vi.fn(),
    } as unknown as CommentModerationService;
    const lifecycle = {
      initialize: vi.fn(),
      recordActivity: vi.fn(),
    } as unknown as LifecycleService;
    await new ModerationPostEventProcessor(moderation, lifecycle).process(
      event('PostCreated'),
    );
    expect(lifecycle.initialize).toHaveBeenCalledWith(
      'post_1',
      '2026-01-01T00:00:00.000Z',
    );
    expect(moderation.moderate).not.toHaveBeenCalled();
  });

  it('moderates comment content before recording meaningful activity', async () => {
    const moderate = vi.fn().mockResolvedValue({});
    const recordActivity = vi.fn();
    const processor = new ModerationPostEventProcessor(
      { moderate } as unknown as CommentModerationService,
      { initialize: vi.fn(), recordActivity } as unknown as LifecycleService,
    );
    await processor.process(event('PostCommentCreated'));
    expect(moderate).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'comment' }),
    );
    expect(moderate.mock.invocationCallOrder[0]).toBeLessThan(
      recordActivity.mock.invocationCallOrder[0]!,
    );
  });

  it.each(['PostReactionCreated', 'PostParticipantJoined'] as const)(
    'ignores %s for lifecycle',
    async (eventType) => {
      const moderation = {
        moderate: vi.fn(),
      } as unknown as CommentModerationService;
      const lifecycle = {
        initialize: vi.fn(),
        recordActivity: vi.fn(),
      } as unknown as LifecycleService;
      await new ModerationPostEventProcessor(moderation, lifecycle).process(
        event(eventType),
      );
      expect(moderation.moderate).not.toHaveBeenCalled();
      expect(lifecycle.recordActivity).not.toHaveBeenCalled();
    },
  );
});
