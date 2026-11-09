import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ContentModerationService } from '../src/content-moderation/content-moderation.service.js';
import { contentEvent } from '../src/content-moderation/content-event.js';
import type { StoredModerationResult } from '../src/content-moderation/moderation-result.js';

const verdict = {
  flagged: true,
  categories: { violence: true },
  categoryScores: { violence: 0.9 },
  model: 'fixture',
};
function fixture() {
  const values = new Map<string, StoredModerationResult>();
  const moderate = vi.fn().mockResolvedValue(verdict);
  const service = new ContentModerationService(
    { moderate },
    {
      find: async (id) => values.get(id) ?? null,
      save: async (result) => {
        if (values.has(result.eventId)) return false;
        values.set(result.eventId, result);
        return true;
      },
    },
  );
  return { values, moderate, service };
}
const input = {
  targetType: 'POST' as const,
  eventId: 'evt_post',
  postId: 'post_1',
  title: 'Private title',
  content: 'Private body',
  postVersion: 2,
  authorId: 42,
  correlationId: 'req_post',
};

describe('post moderation', () => {
  it('evaluates both fields and publishes a versioned fact without source text or comment identity', async () => {
    const f = fixture();
    const saved = await f.service.moderate(input);
    expect(f.moderate).toHaveBeenCalledWith('Private title\n\nPrivate body');
    const event = contentEvent(saved);
    expect(event).toMatchObject({
      targetType: 'POST',
      postId: input.postId,
      postVersion: 2,
      authorId: 42,
      correlationId: 'req_post',
      flagged: true,
    });
    for (const key of [
      'commentId',
      'activityVersion',
      'title',
      'content',
      'sourceHash',
    ])
      expect(event).not.toHaveProperty(key);
    expect(JSON.stringify(saved)).not.toContain('Private');
  });
  it('reuses a retained result and rejects a changed source identity', async () => {
    const f = fixture();
    const first = await f.service.moderate(input);
    expect(await f.service.moderate(input)).toEqual(first);
    for (const change of [
      { title: 'different' },
      { content: 'different' },
      { postVersion: 3 },
      { postId: 'other' },
    ]) {
      await expect(f.service.moderate({ ...input, ...change })).rejects.toThrow(
        'conflicting',
      );
    }
    await expect(
      f.service.moderate({
        targetType: 'COMMENT',
        eventId: input.eventId,
        postId: input.postId,
        commentId: 'comment_1',
        content: input.content,
      }),
    ).rejects.toThrow('conflicting');
    expect(f.moderate).toHaveBeenCalledOnce();
  });
  it('binds title and body separately even if concatenated provider inputs match', async () => {
    const f = fixture();
    await f.service.moderate({ ...input, title: 'a', content: 'b\n\nc' });
    await expect(
      f.service.moderate({ ...input, title: 'a\n\nb', content: 'c' }),
    ).rejects.toThrow('conflicting');
  });
  it('keeps historical comment hashes and untagged stored results reusable', async () => {
    const f = fixture();
    const legacy = {
      ...verdict,
      eventId: 'evt_comment',
      postId: 'post_1',
      commentId: 'comment_1',
      moderatedAt: '2026-01-01T00:00:00.000Z',
      sourceHash: createHash('sha256')
        .update(JSON.stringify(['post_1', 'comment_1', 'body']))
        .digest('hex'),
    };
    f.values.set(legacy.eventId, legacy);
    expect(
      await f.service.moderate({
        targetType: 'COMMENT',
        eventId: legacy.eventId,
        postId: legacy.postId,
        commentId: legacy.commentId,
        content: 'body',
      }),
    ).toEqual(legacy);
    expect(f.moderate).not.toHaveBeenCalled();
    expect(contentEvent(legacy)).toMatchObject({
      targetType: 'COMMENT',
      commentId: 'comment_1',
    });
    await expect(
      f.service.moderate({ ...input, eventId: legacy.eventId }),
    ).rejects.toThrow('conflicting');
  });
  it('does not retain a failed provider call', async () => {
    const f = fixture();
    f.moderate.mockRejectedValue(new Error('unavailable'));
    await expect(f.service.moderate(input)).rejects.toThrow('unavailable');
    expect(f.values.size).toBe(0);
  });
});
