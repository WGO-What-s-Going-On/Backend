import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import type { Connection, Model } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { ExpirationWorker } from '../src/post/infrastructure/expiration.worker.js';
import { VoteWorker } from '../src/post/infrastructure/vote.worker.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { SemanticWorker } from '../src/post/semantic/worker.js';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { serializePostEvent } from '../src/post/infrastructure/post-event-envelope.js';
import { CommentEditConflictError } from '../src/post/domain/post.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('Comment edit HTTP and Mongo transactions', () => {
  let app: INestApplication;
  let posts: Model<Record<string, unknown>>;
  let comments: Model<Record<string, unknown>>;
  let outbox: Model<Record<string, unknown>>;
  const headers = { 'x-user-id': '777' };
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SEMANTIC_MODEL_ENABLED', 'false');
    vi.stubEnv(
      'MONGODB_URI',
      'mongodb://localhost:27017/wgo_comment_edit_integration?replicaSet=rs0',
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOCATION_AUTHORIZATION)
      .useValue({
        assertCanCreate: async () => {},
        resolveRegion: async () => ({
          code: '1159053000',
          name: '서울특별시 동작구 상도1동',
        }),
        assertCanJoin: async () => {},
      })
      .overrideProvider(UserProfiles)
      .useValue({ names: async () => new Map([[777, 'author']]) })
      .overrideProvider(OutboxWorker)
      .useValue({ wake() {} })
      // Timer-driven writes must not race with this suite's fault injection.
      .overrideProvider(ExpirationWorker)
      .useValue({})
      .overrideProvider(VoteWorker)
      .useValue({})
      .overrideProvider(SemanticWorker)
      .useValue({})
      .compile();
    app = module.createNestApplication();
    await app.init();
    await app.get<Connection>(getConnectionToken()).dropDatabase();
    posts = app.get(getModelToken('Post'));
    comments = app.get(getModelToken('Comment'));
    outbox = app.get(getModelToken('Outbox'));
  }, 30000);
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  async function fixture() {
    const { body: post } = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .set(headers)
      .send({
        title: 'board',
        content: 'board content',
        category: 'NEWS',
        latitude: 37,
        longitude: 127,
        radiusM: 150,
      })
      .expect(201);
    const base = `/api/v1/posts/${post.postId}`;
    await request(app.getHttpServer())
      .post(`${base}/participants`)
      .set(headers)
      .send({})
      .expect(201);
    const { body: comment } = await request(app.getHttpServer())
      .post(`${base}/comments`)
      .set(headers)
      .send({ content: 'original' })
      .expect(201);
    return {
      postId: post.postId as string,
      commentId: comment.commentId as string,
      base,
      path: `${base}/comments/${comment.commentId}`,
    };
  }
  it('updates only content and timestamp, preserving reactions, identity and count, with one versioned outbox event', async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .post(`${f.path}/reactions`)
      .set(headers)
      .send({ type: 'HELPFUL' })
      .expect(201);
    const before = await comments.findOne({ commentId: f.commentId }).lean();
    await request(app.getHttpServer())
      .patch(f.path)
      .set(headers)
      .send({ content: ' revised ' })
      .expect(204);
    const after = await comments.findOne({ commentId: f.commentId }).lean();
    expect(after).toMatchObject({
      content: 'revised',
      status: 'ACTIVE',
      authorId: 777,
      createdAt: before?.createdAt,
      reactionCounts: before?.reactionCounts,
      activityVersion: 2,
    });
    expect(after?.updatedAt).toBeInstanceOf(Date);
    const event = await outbox
      .findOne({ aggregateId: f.postId, eventType: 'PostCommentUpdated' })
      .lean();
    expect(JSON.parse(serializePostEvent(event!))).toMatchObject({
      activityVersion: 2,
      comment: { content: 'revised', commentId: f.commentId },
    });
    const detail = await request(app.getHttpServer()).get(f.base).expect(200);
    expect(detail.body.counters.commentCount).toBe(1);
    await request(app.getHttpServer())
      .patch(f.path)
      .set(headers)
      .send({ content: 'revised' })
      .expect(204);
    expect(
      await outbox.countDocuments({
        aggregateId: f.postId,
        eventType: 'PostCommentUpdated',
      }),
    ).toBe(1);
  });
  it('rejects another author, a wrong parent and invalid bodies', async () => {
    const f = await fixture();
    const other = await fixture();
    await request(app.getHttpServer())
      .patch(f.path)
      .set({ 'x-user-id': '888' })
      .send({ content: 'bad' })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`${other.base}/comments/${f.commentId}`)
      .set(headers)
      .send({ content: 'bad' })
      .expect(404);
    for (const body of [
      {},
      { content: '' },
      { content: '   ' },
      { content: 4 },
      { content: 'a'.repeat(2001) },
      { content: 'x', authorId: 888 },
      { content: 'x', mediaIds: [] },
    ]) {
      await request(app.getHttpServer())
        .patch(f.path)
        .set(headers)
        .send(body)
        .expect(400);
    }
    expect(
      (await comments.findOne({ commentId: f.commentId }).lean())?.content,
    ).toBe('original');
  });
  it.each(['closed', 'expired', 'deleted'] as const)(
    'rejects editing on %s posts',
    async (state) => {
      const f = await fixture();
      await posts.updateOne(
        { postId: f.postId },
        {
          $set:
            state === 'closed'
              ? { closedAt: new Date() }
              : state === 'expired'
                ? { expiresAt: new Date(0) }
                : { status: 'DELETED' },
        },
      );
      await request(app.getHttpServer())
        .patch(f.path)
        .set(headers)
        .send({ content: 'revised' })
        .expect(403);
    },
  );
  it('does not resurrect a deleted comment during concurrent deletion', async () => {
    const f = await fixture();
    const [edit] = await Promise.all([
      request(app.getHttpServer())
        .patch(f.path)
        .set(headers)
        .send({ content: 'revised' }),
      request(app.getHttpServer()).delete(f.path).set(headers).expect(204),
    ]);
    expect([204, 403]).toContain(edit.status);
    expect(
      (await comments.findOne({ commentId: f.commentId }).lean())?.status,
    ).toBe('DELETED');
    await request(app.getHttpServer())
      .patch(f.path)
      .set(headers)
      .send({ content: 'again' })
      .expect(403);
  });
  it('serializes edits against candidate selection and rejects selected candidates', async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .post(`${f.base}/comments`)
      .set(headers)
      .send({ content: 'second' })
      .expect(201);
    await posts.updateOne(
      { postId: f.postId },
      { $set: { voteAt: new Date(0) } },
    );
    const [edit] = await Promise.all([
      request(app.getHttpServer())
        .patch(f.path)
        .set(headers)
        .send({ content: 'revised' }),
      app.get(MongooseVote).selectDue(f.postId),
    ]);
    expect([204, 409]).toContain(edit.status);
    const vote = await app.get(MongooseVote).read(f.postId);
    expect(
      vote.candidates.find((candidate) => candidate.commentId === f.commentId)
        ?.content,
    ).toBe(edit.status === 204 ? 'revised' : 'original');
    await request(app.getHttpServer())
      .patch(f.path)
      .set(headers)
      .send({ content: 'later' })
      .expect(409);
  });
  it('rolls the edit back if the outbox cannot be written', async () => {
    const f = await fixture();
    const create = outbox.create.bind(outbox);
    let rejectedWrites = 0;
    const fail = vi.spyOn(outbox, 'create').mockImplementation((...args) => {
      const documents = Array.isArray(args[0]) ? args[0] : [args[0]];
      if (
        documents.some(
          (document) =>
            document.aggregateId === f.postId &&
            document.eventType === 'PostCommentUpdated',
        )
      ) {
        rejectedWrites++;
        return Promise.reject(new Error('outbox unavailable'));
      }
      return create(...args);
    });
    try {
      // An unrelated write must not consume the edit's injected failure.
      await fixture();
      expect(rejectedWrites).toBe(0);
      await request(app.getHttpServer())
        .patch(f.path)
        .set(headers)
        .send({ content: 'revised' })
        .expect(500);
      expect(rejectedWrites).toBeGreaterThan(0);
      expect(
        (await comments.findOne({ commentId: f.commentId }).lean())?.content,
      ).toBe('original');
      expect(
        await outbox.countDocuments({
          aggregateId: f.postId,
          eventType: 'PostCommentUpdated',
        }),
      ).toBe(0);
    } finally {
      fail.mockRestore();
    }
  });
  it('rejects an old moderation decision and applies only the reviewed version', async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .patch(f.path)
      .set(headers)
      .send({ content: 'revised' })
      .expect(204);
    const lifecycle = app.get(PostLifecycle);
    await expect(
      lifecycle.moderateComment(f.postId, f.commentId, 'old-decision'),
    ).rejects.toBeInstanceOf(CommentEditConflictError);
    expect(
      (await comments.findOne({ commentId: f.commentId }).lean())?.status,
    ).toBe('ACTIVE');
    await lifecycle.moderateComment(f.postId, f.commentId, 'reviewed-v2', 2);
    expect(
      (await comments.findOne({ commentId: f.commentId }).lean())?.status,
    ).toBe('DELETED');
  });
});
