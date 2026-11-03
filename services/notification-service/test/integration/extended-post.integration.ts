import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { wire } from '../helpers/post-events.js';
import {
  parsePostEvent,
  type PostEvent,
} from '../../src/event-consumer/post-event.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import type { NotificationBlockChecker } from '../../src/notification/block-checker.js';

describe('extended Post facts with PostgreSQL', () => {
  let h: Awaited<ReturnType<typeof harness>>, store: PostgresEventStore;
  const postId = 'post_extended',
    at = new Date().toISOString();
  const parse = (value: Record<string, unknown>) =>
    parsePostEvent(JSON.stringify(value))!;
  const base = (eventType: string) => ({
    eventType,
    eventId: `evt_${randomUUID()}`,
    schemaVersion: 1,
    producer: 'post-service',
    aggregateId: postId,
    correlationId: 'req_test',
    occurredAt: at,
    postAuthorId: 1,
    postCategory: 'INCIDENT',
    activityVersion: 1,
  });
  const reply = (id: string, parentAuthor = 3, actor = 2) =>
    parse({
      ...JSON.parse(
        wire('PostCommentCreated', { postId, commentId: id, actor }).data,
      ),
      parentCommentAuthorId: parentAuthor,
      comment: {
        commentId: id,
        postId,
        authorId: actor,
        content: 'reply',
        status: 'ACTIVE',
        createdAt: at,
        updatedAt: null,
        parentCommentId: 'parent',
      },
    });
  const reaction = (
    version = 1,
    removed = false,
    actor = 2,
    reactionType = 'HELPFUL',
  ) =>
    parse({
      ...base(
        removed ? 'PostCommentReactionRemoved' : 'PostCommentReactionCreated',
      ),
      activityVersion: version,
      commentAuthorId: 3,
      commentReaction: {
        postId,
        commentId: 'parent',
        userId: actor,
        type: reactionType,
        createdAt: at,
        ...(removed ? { removedAt: at } : {}),
      },
    });
  const vote = (commentId: string, won = false) =>
    parse({
      ...base(won ? 'PostVoteWon' : 'PostVoteCandidateSelected'),
      [won ? 'vote' : 'candidate']: {
        postId,
        commentId,
        ...(won
          ? { winnerAuthorId: 3, resultId: postId, votes: 2, closedAt: at }
          : { authorId: 3, scoreAtSelection: 0, selectedAt: at }),
        regionCode: null,
      },
    });
  const items = async (id = '3') => (await h.notifications.list(id, 100)).items;
  beforeEach(async () => {
    h = await harness();
    store = new PostgresEventStore(h.database);
  });
  afterEach(async () => {
    await h.cleanup();
  });
  it('deduplicates reply recipients, excludes self and groups two replies for two minutes', async () => {
    await store.apply(reply('child1', 1));
    expect(await items('1')).toHaveLength(1);
    await store.apply(reply('child2', 1));
    expect((await items('1'))[0]?.count).toBe(2);
    expect(await store.deliveries(postId)).toHaveLength(1);
    await store.apply(reply('self', 2));
    expect(await items('2')).toHaveLength(0);
    await store.apply(reply('child3', 3));
    expect(await items()).toHaveLength(1);
    expect((await items())[0]?.type).toBe('COMMENT_REPLIED');
  });
  it('requires authoritative parent author, supports observed parents, and never guesses', async () => {
    const missing = reply('child');
    delete missing.parentCommentAuthorId;
    await expect(store.apply(missing)).rejects.toThrow(
      'Parent comment author unavailable',
    );
    expect(
      await h.database.pool.query('SELECT * FROM notification_event_inbox'),
    ).toMatchObject({ rowCount: 0 });
    await store.apply(
      parsePostEvent(
        wire('PostCommentCreated', { postId, commentId: 'parent', actor: 3 })
          .data,
      )!,
    );
    await store.apply(missing);
    expect(await items()).toHaveLength(1);
  });
  it('rejects conflicting immutable Post, parent and comment identities without committing receipts', async () => {
    await store.apply(
      parsePostEvent(
        wire('PostCommentCreated', { postId, commentId: 'parent', actor: 3 })
          .data,
      )!,
    );
    const badPost = reply('bad-post');
    badPost.postAuthorId = '9';
    await expect(store.apply(badPost)).rejects.toThrow('immutable Post author');
    await expect(store.apply(reply('bad-parent', 4))).rejects.toThrow(
      'parent author conflict',
    );
    const badReaction = reaction();
    badReaction.commentAuthorId = '4';
    await expect(store.apply(badReaction)).rejects.toThrow(
      'immutable comment author',
    );
    expect(
      (await h.database.pool.query('SELECT * FROM notification_event_inbox'))
        .rowCount,
    ).toBe(1);
    expect(await items()).toHaveLength(0);
  });
  it.each(['HELPFUL', 'AGREE', 'DIFFERENT'])(
    'versions %s create/remove/recreate and excludes self',
    async (kind) => {
      const created = reaction(1, false, 2, kind);
      await store.apply(created);
      await store.apply(created);
      expect((await items())[0]?.metadata?.reactionType).toBe(kind);
      await store.apply(reaction(2, true, 2, kind));
      await store.apply(created);
      expect(await items()).toHaveLength(0);
      await store.apply(reaction(3, false, 2, kind));
      expect((await items())[0]?.count).toBe(1);
      await store.apply(reaction(1, false, 3, kind));
      expect((await items())[0]?.count).toBe(1);
    },
  );
  it('handles removal before creation and parent deletion before delayed replies and reactions', async () => {
    await store.apply(reaction(2, true));
    await store.apply(reaction());
    expect(await items()).toHaveLength(0);
    await store.apply(
      parsePostEvent(
        wire('PostCommentDeleted', { postId, commentId: 'parent', actor: 3 })
          .data,
      )!,
    );
    await store.apply(reply('late'));
    await store.apply(reaction(3));
    expect(await items()).toHaveLength(0);
    expect(await items('1')).toHaveLength(0);
  });
  it('cancels a queued reply when its parent is deleted', async () => {
    await store.apply(reply('child'));
    await store.apply(
      parsePostEvent(
        wire('PostCommentDeleted', { postId, commentId: 'parent', actor: 3 })
          .data,
      )!,
    );
    expect(await items()).toHaveLength(0);
    expect(await items('1')).toHaveLength(0);
    expect(await store.deliveries(postId)).toHaveLength(0);
  });
  it('keeps two candidate facts but sends one product notification per post/user; victory is separate', async () => {
    await Promise.all([store.apply(vote('a')), store.apply(vote('b'))]);
    expect(await items()).toHaveLength(1);
    expect((await items())[0]?.count).toBe(1);
    expect(
      (
        await h.database.pool.query(
          "SELECT * FROM notification_activities WHERE details->>'kind'='candidate'",
        )
      ).rowCount,
    ).toBe(2);
    await store.apply(
      parsePostEvent(
        wire('PostCommentDeleted', { postId, commentId: 'a', actor: 3 }).data,
      )!,
    );
    expect(await items()).toHaveLength(1);
    await store.apply(vote('b', true));
    expect(await items()).toHaveLength(2);
    await store.apply(
      parsePostEvent(
        wire('PostCommentDeleted', { postId, commentId: 'b', actor: 3 }).data,
      )!,
    );
    expect(await items()).toHaveLength(0);
  });
  it('honors actual manual close/reopen versions without reviving deleted posts', async () => {
    const update = (version: number, closedAt: string | null): PostEvent =>
      parse({
        ...base('PostUpdated'),
        postVersion: version,
        post: { postId, authorId: 1, category: 'INCIDENT', closedAt },
      });
    await store.apply(update(3, at));
    await store.apply(reply('blocked'));
    expect(await items()).toHaveLength(0);
    await store.apply(update(2, null));
    await store.apply(reply('old'));
    expect(await items()).toHaveLength(0);
    await store.apply(update(4, null));
    await store.apply(reply('open'));
    expect(await items()).toHaveLength(1);
    await store.apply(
      parsePostEvent(wire('PostDeleted', { postId, postVersion: 5 }).data)!,
    );
    await store.apply(update(6, null));
    await store.apply(reply('deleted'));
    expect(await items()).toHaveLength(1);
    expect(await store.deliveries(postId)).toHaveLength(0);
  });
  it('fails closed on unavailable block authority and checks again before FCM', async () => {
    const allowed = vi.fn().mockResolvedValue(false),
      blocks = { allowed } as unknown as NotificationBlockChecker;
    store = new PostgresEventStore(h.database, blocks);
    await store.apply(reply('blocked'));
    expect(await items()).toHaveLength(0);
    allowed.mockRejectedValueOnce(new Error('User unavailable'));
    await expect(store.apply(reply('pending'))).rejects.toThrow(
      'User unavailable',
    );
    allowed.mockResolvedValue(true);
    await store.apply(reply('allowed'));
    expect(await items()).toHaveLength(1);
    const send = vi.fn();
    allowed.mockResolvedValue(false);
    await new PostEventHandler(
      store,
      h.state,
      { send },
      undefined,
      blocks,
    ).dispatch(postId);
    expect(send).not.toHaveBeenCalled();
  });
});
