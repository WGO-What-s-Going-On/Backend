import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, Model } from 'mongoose';
import type { MediaRecord } from '../src/post/media/media.schema.js';
import { ConfigService } from '@nestjs/config';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { MongoosePostStore } from '../src/post/infrastructure/mongoose-post.store.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { event } from '../src/post/application/event.js';
import {
  SemanticConsumer,
  type SemanticRedis,
} from '../src/post/semantic/worker.js';
import { withLogContext } from '../src/observability/logging.js';
import { IndexSemanticPost } from '../src/post/semantic/index-post.js';

const now = new Date('2026-11-03T13:00:00Z');
const postId = 'post_11111111-1111-4111-8111-111111111111';
const model = <T = never>(value: unknown) => value as Model<T>;
const query = (value: unknown) => ({
  session: () => ({ lean: async () => value }),
});
let lines: string[];
beforeEach(() => {
  lines = [];
  vi.stubEnv('LOG_LEVEL', 'DEBUG');
  vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const logs = () => lines.map((line) => JSON.parse(line));

describe('committed vote logs', () => {
  function votes(commit = true, comments = 2, pending = true) {
    const connection = {
      transaction: async (work: (session: unknown) => Promise<unknown>) => {
        const value = await work({});
        expect(lines).toEqual([]);
        if (!commit) throw new Error('private database content');
        return value;
      },
    } as unknown as Connection;
    const posts = model({
      findOne: () =>
        query({
          status: 'ACTIVE',
          voteAt: now,
          vote: { status: pending ? 'PENDING' : 'OPEN' },
        }),
      updateOne: async () => ({ matchedCount: 1 }),
    });
    const rows = Array.from({ length: comments }, (_, i) => ({
      commentId: `comment_${i}`,
      content: 'private comment',
      authorId: 123,
      createdAt: now,
    }));
    return new MongooseVote(
      connection,
      posts,
      model({
        find: () => query(rows),
        updateOne: async () => ({ matchedCount: 1 }),
      }),
      model({}),
      model({ create: async () => {} }),
      {} as never,
    );
  }
  it('emits opening and both candidate identifiers only after commit without comment content', async () => {
    await votes().selectDue(postId, now);
    expect(logs().map((log) => log.event)).toEqual([
      'vote.opened',
      'vote.candidate_selected',
      'vote.candidate_selected',
    ]);
    expect(logs()[0]).toMatchObject({
      service: 'post-service',
      domain: 'vote',
      outcome: 'success',
      severity: 'INFO',
      candidateCount: 2,
    });
    expect(lines.join('')).not.toContain('private comment');
  });
  it('never reports success when the transaction rolls back', async () => {
    await expect(votes(false).selectDue(postId, now)).rejects.toThrow();
    expect(lines).toEqual([]);
  });
  it('distinguishes insufficient candidates from already processed votes', async () => {
    await votes(true, 1).selectDue(postId, now);
    expect(logs()[0]).toMatchObject({ event: 'vote.none', status: 'NONE' });
    lines.length = 0;
    await votes(true, 2, false).selectDue(postId, now);
    expect(logs()[0]).toMatchObject({
      outcome: 'skipped',
      reasonCode: 'NOT_DUE_OR_INACTIVE',
    });
  });
});

it('logs only the committed driver retry attempt, including a tied vote closing without a winner', async () => {
  const connection = {
    transaction: async (work: (session: unknown) => Promise<unknown>) => {
      await work({});
      expect(lines).toEqual([]);
      return work({});
    },
  } as unknown as Connection;
  const posts = model({
    findOne: () =>
      query({
        vote: { status: 'OPEN', candidates: [{ votes: 2 }, { votes: 2 }] },
      }),
    updateOne: async () => ({ matchedCount: 1 }),
  });
  const empty = model({});
  const store = new MongoosePostStore(
    connection,
    posts,
    empty,
    empty,
    empty,
    empty,
    model({ create: async () => {} }),
    empty,
    empty,
    new ConfigService({ post: { bucketCount: 1 } }),
    { wake: vi.fn() } as unknown as OutboxWorker,
    model<MediaRecord>({}),
  );
  await store.execute(async (tx) => {
    await tx.commands.closeVote(postId, now);
    await tx.commands.appendEvent(event(postId, 'PostExpired', {}, now));
  });
  expect(logs()).toHaveLength(2);
  expect(logs()[0]).toMatchObject({
    event: 'domain.event_committed',
    eventType: 'PostExpired',
  });
  expect(logs()[1]).toMatchObject({
    event: 'vote.closed',
    status: 'CLOSED',
    hasWinner: false,
    tie: true,
    totalVotes: 4,
  });
});

it('records malformed semantic events as failures and logs DLQ completion only after acknowledgement', async () => {
  const redis = {
    xPendingRange: async () => [{ deliveriesCounter: 1 }],
    xAdd: vi.fn(async () => '2-0'),
    xAck: vi.fn(async () => {
      expect(logs().some((log) => log.event === 'semantic.dead_lettered')).toBe(
        false,
      );
      return 1;
    }),
  };
  const indexing = {
    embedding: { version: 'test' },
  } as unknown as IndexSemanticPost;
  await new SemanticConsumer(
    redis as unknown as SemanticRedis,
    indexing,
  ).process({
    id: '1-0',
    message: { eventType: 'PostCreated', data: 'private payload' },
  });
  expect(logs()[0]).toMatchObject({
    domain: 'semantic',
    outcome: 'failure',
    error: { code: 'SEMANTIC_EVENT_TERMINAL', retryable: false },
  });
  expect(logs()[1]).toMatchObject({
    event: 'semantic.dead_lettered',
    outcome: 'success',
  });
  expect(lines.join('')).not.toContain('private payload');
});

it('preserves incoming correlation when creating an outbox event', () => {
  const created = withLogContext({ correlationId: 'request-existing' }, () =>
    event(postId, 'PostExpired', {}, now),
  );
  expect(created.correlationId).toBe('request-existing');
});
