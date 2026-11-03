import { randomUUID } from 'node:crypto';
import { createConnection } from 'mongoose';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import {
  CommentSchema,
  OutboxSchema,
  PostSchema,
  VoteSelectionSchema,
} from '../src/post/infrastructure/post.schemas.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('vote candidate events with MongoDB and Redis', () => {
  const db = createConnection();
  const posts = db.model('Post', PostSchema);
  const comments = db.model('Comment', CommentSchema);
  const outbox = db.model('Outbox', OutboxSchema);
  const selections = db.model('VoteSelection', VoteSelectionSchema);
  let votes: MongooseVote;
  let worker: OutboxWorker;
  const redis = createClient({ url: 'redis://localhost:6380/10' });
  const selectedAt = new Date('2026-01-01T00:30:00.000Z');

  beforeAll(async () => {
    vi.stubEnv('REDIS_URL', 'redis://localhost:6380/10');
    await db.openUri(
      'mongodb://localhost:27017/wgo_vote_candidate_events_integration?replicaSet=rs0',
    );
    await db.dropDatabase();
    for (const model of Object.values(db.models)) await model.syncIndexes();
    votes = new MongooseVote(db, posts, comments, selections, outbox, {
      assertCanCreate: async () => {},
      resolveRegion: async () => ({
        code: '1159053000',
        name: '서울특별시 동작구 상도1동',
      }),
      assertCanJoin: async () => {},
    });
    worker = new OutboxWorker(outbox);
    await redis.connect();
    await redis.del('post:events');
  }, 30000);

  afterAll(async () => {
    await worker?.onModuleDestroy();
    if (redis.isOpen) {
      await redis.del('post:events');
      await redis.quit();
    }
    await db?.close();
    vi.unstubAllEnvs();
  });

  async function fixture(authors = [456, 789, 999]) {
    const postId = `post_${randomUUID()}`;
    await posts.create({
      postId,
      authorId: 123,
      category: 'NEWS',
      title: 'Candidate selection',
      content: 'Board',
      status: 'ACTIVE',
      radiusM: 150,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: selectedAt,
      voteAt: selectedAt,
      vote: {
        status: 'PENDING',
        candidates: [],
        selectedAt: null,
        closedAt: null,
        winner: null,
      },
    });
    const candidates = authors.map((authorId, index) => ({
      postId,
      commentId: `comment_${randomUUID()}`,
      authorId,
      content: `Comment ${index}`,
      status: 'ACTIVE',
      reactionCounts: {
        HELPFUL: index === 0 ? 2 : 0,
        AGREE: index === 0 ? 3 : 0,
        DIFFERENT: 0,
      },
      createdAt: new Date(index * 1000),
    }));
    await comments.create(candidates);
    return { postId, candidates };
  }

  const events = (postId: string) =>
    outbox
      .find({ aggregateId: postId, eventType: 'PostVoteCandidateSelected' })
      .lean();

  it('publishes the top two candidate facts once despite concurrent and repeated selection', async () => {
    const { postId, candidates } = await fixture();
    await posts.updateOne(
      { postId },
      {
        $set: {
          region: { code: '1159053000', name: '서울특별시 동작구 상도1동' },
        },
      },
    );
    await Promise.all(
      Array.from({ length: 4 }, () => votes.selectDue(postId, selectedAt)),
    );
    await votes.selectDue(postId, selectedAt);
    expect((await votes.read(postId)).status).toBe('OPEN');
    const rows = await events(postId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.payload)).toEqual(
      expect.arrayContaining(
        candidates.slice(0, 2).map((candidate, index) => ({
          candidate: {
            postId,
            commentId: candidate.commentId,
            authorId: candidate.authorId,
            scoreAtSelection: index === 0 ? 5 : 0,
            regionCode: '1159053000',
            selectedAt,
          },
          activityVersion: 1,
        })),
      ),
    );
    await worker.publishPending();
    const messages = (await redis.xRange('post:events', '-', '+'))
      .map(({ message }) => ({
        fields: message,
        data: JSON.parse(message.data!),
      }))
      .filter(({ data }) => data.aggregateId === postId);
    expect(messages).toHaveLength(2);
    for (const { fields, data } of messages) {
      expect(data).toMatchObject({
        eventId: fields.eventId,
        eventType: 'PostVoteCandidateSelected',
        schemaVersion: 1,
        producer: 'post-service',
        aggregateId: postId,
        occurredAt: selectedAt.toISOString(),
        activityVersion: 1,
        candidate: {
          postId,
          selectedAt: selectedAt.toISOString(),
          regionCode: '1159053000',
        },
      });
      expect(fields.eventType).toBe(data.eventType);
      expect(data).not.toHaveProperty('payload');
      expect(data.candidate).not.toHaveProperty('content');
    }
    expect(
      (await events(postId)).every((row) => row.status === 'PUBLISHED'),
    ).toBe(true);
    expect(
      await outbox.countDocuments({
        aggregateId: postId,
        eventType: 'PostVoteWon',
      }),
    ).toBe(0);
  });

  it('keeps two separate comment facts when one author owns both candidates', async () => {
    const { postId } = await fixture([456, 456]);
    await votes.selectDue(postId, selectedAt);
    const rows = await events(postId);
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row.payload).toMatchObject({
        candidate: { authorId: 456, regionCode: null },
      });
  });

  it.each([
    ['not due', { voteAt: new Date(selectedAt.getTime() + 1) }],
    ['deleted', { status: 'DELETED' }],
    ['closed', { closedAt: selectedAt }],
    ['expired', { expiresAt: selectedAt }],
  ])('does not emit when the post is %s', async (_name, changes) => {
    const { postId } = await fixture();
    await posts.updateOne({ postId }, { $set: changes });
    await votes.selectDue(postId, selectedAt);
    expect(await events(postId)).toEqual([]);
    expect((await votes.read(postId)).status).toBe('PENDING');
  });

  it('does not emit when fewer than two active comments exist', async () => {
    const { postId } = await fixture([456]);
    await votes.selectDue(postId, selectedAt);
    expect(await events(postId)).toEqual([]);
    expect((await votes.read(postId)).status).toBe('NONE');
  });

  it('rolls back the first event and OPEN state if the second event cannot be stored', async () => {
    const { postId } = await fixture();
    const insert = outbox.collection.insertOne.bind(outbox.collection);
    let writes = 0;
    const fail = vi
      .spyOn(outbox.collection, 'insertOne')
      .mockImplementation(async (...args) => {
        if (++writes === 2) throw new Error('Outbox unavailable');
        return insert(...args);
      });
    try {
      await expect(votes.selectDue(postId, selectedAt)).rejects.toThrow(
        'Outbox unavailable',
      );
    } finally {
      fail.mockRestore();
    }
    expect(await events(postId)).toEqual([]);
    expect((await votes.read(postId)).status).toBe('PENDING');
    expect(
      await comments.countDocuments({ postId, voteSelectionFence: { $ne: 0 } }),
    ).toBe(0);
    await votes.selectDue(postId, selectedAt);
    expect(await events(postId)).toHaveLength(2);
    expect((await votes.read(postId)).status).toBe('OPEN');
  });
});
