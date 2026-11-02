import { describe, it, expect, vi } from 'vitest';
import { CommentModerationService } from '../src/content-moderation/comment-moderation.service.js';
import type { StoredModerationResult } from '../src/content-moderation/moderation-result.js';
import { contentEvent } from '../src/content-moderation/content-event.js';
import { LifecycleService } from '../src/lifecycle/lifecycle.service.js';
import type {
  LifecycleProjection,
  LifecycleEvent,
} from '../src/lifecycle/lifecycle.js';
import { ModerationPostEventProcessor } from '../src/event-consumer/moderation-post-event.processor.js';
import {
  parsePostEvent,
  type PostEvent,
} from '../src/event-consumer/post-event.js';

function event(version: number): PostEvent {
  return {
    eventId: `edit_${version}`,
    aggregateId: 'post_1',
    eventType: 'PostCommentUpdated',
    schemaVersion: 1,
    producer: 'post-service',
    correlationId: 'req_1',
    occurredAt: `2026-01-01T00:0${version}:00.000Z`,
    activityVersion: version,
    comment: {
      postId: 'post_1',
      commentId: 'comment_1',
      authorId: 1,
      content: `content ${version}`,
    },
  };
}
function fixture() {
  const projections = new Map<string, LifecycleProjection>();
  const results = new Map<string, StoredModerationResult>();
  const published: ReturnType<typeof contentEvent>[] = [];
  const moderate = vi.fn(async (_content: string) => ({
    flagged: false,
    categories: {},
    categoryScores: {},
    model: 'test',
  }));
  const lifecycle = new LifecycleService({
    create: async (value) => {
      if (projections.has(value.postId)) return false;
      projections.set(value.postId, value);
      return true;
    },
    find: async (postId) => projections.get(postId) ?? null,
    list: async () => [...projections.values()],
    transition: async (
      version: number,
      next: LifecycleProjection,
      _event?: LifecycleEvent,
    ) => {
      if (projections.get(next.postId)?.version !== version) return false;
      projections.set(next.postId, next);
      return true;
    },
  });
  const moderation = new CommentModerationService(
    { moderate },
    {
      find: async (id) => results.get(id) ?? null,
      save: async (result) => {
        results.set(result.eventId, result);
        published.push(contentEvent(result));
        return true;
      },
    },
  );
  return {
    lifecycle,
    moderate,
    published,
    projections,
    processor: new ModerationPostEventProcessor(moderation, lifecycle),
  };
}
describe('Edited comment moderation', () => {
  it('validates the new event content, timestamp and required version', () => {
    const source = event(2);
    const encode = (value: unknown) => ({
      eventId: source.eventId,
      eventType: source.eventType,
      data: JSON.stringify(value),
    });
    const valid = {
      ...source,
      comment: { ...source.comment, updatedAt: source.occurredAt },
    };
    expect(parsePostEvent(encode(valid))).toMatchObject({ activityVersion: 2 });
    expect(() =>
      parsePostEvent(encode({ ...valid, activityVersion: undefined })),
    ).toThrow();
    expect(() =>
      parsePostEvent(
        encode({ ...valid, comment: { ...valid.comment, content: '' } }),
      ),
    ).toThrow();
    expect(() => parsePostEvent(encode(source))).toThrow();
  });
  it('re-moderates edits, tags output with the body version and skips older arrivals', async () => {
    const f = fixture();
    await f.lifecycle.initialize('post_1', '2026-01-01T00:00:00.000Z');
    await f.processor.process(event(2));
    await f.processor.process(event(3));
    await f.processor.process(event(2));
    expect(f.moderate.mock.calls.map(([content]) => content)).toEqual([
      'content 2',
      'content 3',
    ]);
    expect(f.published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activityVersion: 2 }),
        expect.objectContaining({ activityVersion: 3 }),
      ]),
    );
    expect(f.projections.get('post_1')?.comments?.comment_1).toEqual({
      version: 3,
      deleted: false,
    });
  });
  it('keeps the newer projection when an older provider result finishes late', async () => {
    const f = fixture();
    await f.lifecycle.initialize('post_1', '2026-01-01T00:00:00.000Z');
    let finish = () => {};
    let started = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.moderate.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        flagged: false,
        categories: {},
        categoryScores: {},
        model: 'test',
      };
    });
    const old = f.processor.process(event(2));
    await startedPromise;
    await f.processor.process(event(3));
    finish();
    await old;
    expect(f.projections.get('post_1')?.comments?.comment_1).toEqual({
      version: 3,
      deleted: false,
    });
    expect(f.published.map((result) => result.activityVersion)).toEqual([3, 2]);
  });
  it('does not process edits after a deletion tombstone', async () => {
    const f = fixture();
    await f.lifecycle.initialize('post_1', '2026-01-01T00:00:00.000Z');
    await f.lifecycle.recordComment(
      'post_1',
      'comment_1',
      4,
      true,
      '2026-01-01T00:04:00.000Z',
      'req_1',
    );
    await f.processor.process(event(3));
    expect(f.moderate).not.toHaveBeenCalled();
    expect(f.projections.get('post_1')?.comments?.comment_1).toEqual({
      version: 4,
      deleted: true,
    });
  });
});
