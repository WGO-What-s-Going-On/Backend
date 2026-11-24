import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'mongoose';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCampusEvents } from '../src/post/application/create-campus-events.js';
import {
  CAMPUS_CONTENT,
  CAMPUS_DURATION_MS,
  CAMPUS_POLICY,
  CAMPUS_POST_IDS,
} from '../src/post/domain/campus-events.js';
import { MongoosePostStore } from '../src/post/infrastructure/mongoose-post.store.js';
import * as schemas from '../src/post/infrastructure/post.schemas.js';
import { MediaSchema } from '../src/post/media/media.schema.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { VoteWorker } from '../src/post/infrastructure/vote.worker.js';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { ExpirationWorker } from '../src/post/infrastructure/expiration.worker.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { ApplyModerationLifecycle } from '../src/post/application/moderation.js';
import {
  CreatePost,
  CreateComment,
  CreateReaction,
  CreateCommentReaction,
  JoinPost,
} from '../src/post/application/commands.js';
import { HashPartitionStrategy } from '../src/post/application/partition.js';
import { LocationDeniedError } from '../src/post/application/errors.js';
import {
  PostReactionType,
  CommentReactionType,
} from '../src/post/domain/post.js';
import { postInput } from '../src/post/presentation/post.input.js';
import { validateCampusManifest } from '../src/post/infrastructure/campus-events.preflight.js';

const suite =
  process.env.RUN_CAMPUS_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'isolated administrator campaign creation, participation and expiry',
  () => {
    // Dedicated local ports and a fresh random DB: never touch an existing test/service DB.
    const db = createConnection();
    const redis = createClient({
      url: 'redis://127.0.0.1:16380/14',
      socket: { reconnectStrategy: false },
    });
    const posts = db.model('Post', schemas.PostSchema, 'posts');
    const comments = db.model(
      'Comment',
      schemas.CommentSchema,
      'post_comments',
    );
    const reactions = db.model(
      'Reaction',
      schemas.ReactionSchema,
      'post_reactions',
    );
    const commentReactions = db.model(
      'CommentReaction',
      schemas.CommentReactionSchema,
      'post_comment_reactions',
    );
    const participants = db.model(
      'Participant',
      schemas.ParticipantSchema,
      'post_participants',
    );
    const counters = db.model<any>(
      'Counter',
      schemas.CounterSchema,
      'post_counters',
    );
    const outbox = db.model('Outbox', schemas.OutboxSchema, 'outbox_events');
    const receipts = db.model(
      'ModerationReceipt',
      schemas.ModerationReceiptSchema,
      'moderation_receipts',
    );
    const media = db.model('Media', MediaSchema, 'post_media');
    const selections = db.model(
      'VoteSelection',
      schemas.VoteSelectionSchema,
      'post_vote_selections',
    );
    const store = new MongoosePostStore(
      db,
      posts,
      comments,
      reactions,
      commentReactions,
      participants,
      outbox,
      counters,
      receipts,
      new ConfigService({ post: { bucketCount: 2 } }),
      { wake() {} } as OutboxWorker,
      media,
    );
    const partition = new HashPartitionStrategy();
    const input = {
      authorId: 42,
      latitude: 37.505,
      longitude: 126.958,
      region: { code: '1159051000', name: 'local synthetic test region' },
    };
    let actorDistance = 350;
    const auth = {
      resolveRegion: async () => input.region,
      assertCanCreate: vi.fn(async () => {}),
      assertCanJoin: vi.fn(
        async (
          _user: number,
          _id: string,
          _lat: number,
          _lon: number,
          radius: number,
        ) => {
          if (actorDistance > radius)
            throw new LocationDeniedError('OUT_OF_RANGE');
        },
      ),
    };
    let publisher: OutboxWorker;
    let normalId: string;
    beforeAll(async () => {
      vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:16380/14');
      await db.openUri(
        `mongodb://127.0.0.1:27029/wgo_campus_${randomUUID().replaceAll('-', '')}?replicaSet=rs0&directConnection=true`,
      );
      for (const model of Object.values(db.models)) await model.init();
      await redis.connect();
      if ((await redis.dbSize()) !== 0)
        throw new Error('Dedicated Redis DB must be empty');
      publisher = new OutboxWorker(outbox);
      normalId = (
        await new CreatePost(store, auth).execute(
          {
            title: 'control',
            content: 'unchanged ordinary post',
            category: 'NEWS',
            latitude: input.latitude,
            longitude: input.longitude,
            radiusM: 150,
          },
          99,
        )
      ).postId;
    }, 30000);
    afterAll(async () => {
      vi.useRealTimers();
      await publisher?.onModuleDestroy();
      if (redis.isOpen) {
        await redis.del('post:events');
        await redis.quit();
      }
      if (db.readyState === 1) await db.dropDatabase();
      await db.close();
      vi.unstubAllEnvs();
    });
    it('dry-runs with zero writes, creates atomically and retries without new posts/counters/events', async () => {
      const control = await posts.findOne({ postId: normalId }).lean();
      const before = [
        await posts.countDocuments(),
        await counters.countDocuments(),
        await outbox.countDocuments(),
      ];
      await createCampusEvents(store, input);
      expect([
        await posts.countDocuments(),
        await counters.countDocuments(),
        await outbox.countDocuments(),
      ]).toEqual(before);
      await Promise.all([
        createCampusEvents(store, input, false),
        createCampusEvents(store, input, false),
      ]);
      const originals = await posts
        .find({ postId: { $in: [...CAMPUS_POST_IDS] } })
        .sort({ postId: 1 })
        .lean();
      expect(originals).toHaveLength(2);
      originals.forEach((p, i) => {
        expect(p.title).toBe(CAMPUS_CONTENT[i]!.title);
        expect(p.content).toBe(CAMPUS_CONTENT[i]!.content);
        expect(p.expiresAt.getTime() - p.createdAt.getTime()).toBe(
          CAMPUS_DURATION_MS,
        );
        expect(p.vote.status).toBe('NONE');
        expect(p.lifecyclePolicy).toBe(CAMPUS_POLICY);
      });
      const inventory = [
        await posts.countDocuments(),
        await counters.countDocuments(),
        await outbox.countDocuments(),
      ];
      await createCampusEvents(store, input, false);
      expect([
        await posts.countDocuments(),
        await counters.countDocuments(),
        await outbox.countDocuments(),
      ]).toEqual(inventory);
      expect(await posts.findOne({ postId: normalId }).lean()).toEqual(control);
      expect(
        await outbox.countDocuments({
          aggregateId: { $in: [...CAMPUS_POST_IDS] },
          eventType: 'PostCreated',
        }),
      ).toBe(2);
    });
    it('rejects changed identities, public policy input and leaves normal voting PENDING', async () => {
      await expect(
        createCampusEvents(store, { ...input, authorId: 43 }, false),
      ).rejects.toThrow('conflicts');
      expect(() =>
        postInput({
          title: 'x',
          content: 'x',
          category: 'NEWS',
          latitude: 0,
          longitude: 0,
          radiusM: 350,
          lifecyclePolicy: CAMPUS_POLICY,
        }),
      ).toThrow('Unknown field');
      expect(
        (await posts.findOne({ postId: normalId }).lean())!.vote.status,
      ).toBe('PENDING');
    });
    it('never selects NONE candidates, ignores old BOARD_CLOSED only for campaigns', async () => {
      const votes = new MongooseVote(
        db,
        posts,
        comments,
        selections,
        outbox,
        auth,
        counters as unknown as ConstructorParameters<typeof MongooseVote>[6],
      );
      const worker = new VoteWorker(posts, votes);
      await worker.runOnce();
      for (const id of CAMPUS_POST_IDS) {
        await votes.selectDue(id);
        expect((await posts.findOne({ postId: id }).lean())!.vote.status).toBe(
          'NONE',
        );
      }
      actorDistance = 150;
      await new JoinPost(store, store, auth, partition).execute(normalId, 79);
      const write = new CreateComment(store, store, partition, auth);
      await write.execute(normalId, 'normal candidate one', 79);
      await write.execute(normalId, 'normal candidate two', 79);
      await comments.updateMany(
        { postId: normalId },
        { $set: { 'reactionCounts.HELPFUL': 20 } },
      );
      await posts.updateOne(
        { postId: normalId },
        { $set: { 'counters.viewCount': 100 } },
      );
      await votes.selectDue(normalId);
      expect(
        (await posts.findOne({ postId: normalId }).lean())!.vote.status,
      ).toBe('OPEN');
      const apply = new ApplyModerationLifecycle(store);
      const close = (id: string) => ({
        postId: id,
        eventId: `evt_${randomUUID()}`,
        eventType: 'BOARD_CLOSED' as const,
        occurredAt: new Date(),
        correlationId: 'local-old-pod',
      });
      await apply.execute(close(CAMPUS_POST_IDS[0]));
      expect(
        (await posts.findOne({ postId: CAMPUS_POST_IDS[0] }).lean())!.status,
      ).toBe('ACTIVE');
      await apply.execute(close(normalId));
      expect((await posts.findOne({ postId: normalId }).lean())!.status).toBe(
        'EXPIRED',
      );
      expect(
        (await posts.findOne({ postId: normalId }).lean())!.vote.status,
      ).toBe('CLOSED');
    });
    it('allows comments and both reactions at 350m, denies them beyond 350m', async () => {
      const id = CAMPUS_POST_IDS[0];
      const join = new JoinPost(store, store, auth, partition);
      const write = new CreateComment(store, store, partition, auth);
      const react = new CreateReaction(store, store, partition, auth);
      const agree = new CreateCommentReaction(store, store, auth);
      actorDistance = 350;
      await join.execute(id, 79);
      const comment = await write.execute(id, 'local participant', 79);
      expect(comment.verified).toBe(false); // Existing 150m verified badge semantics are preserved.
      await react.execute(id, 79, PostReactionType.HELPFUL);
      await agree.execute(id, comment.commentId, 79, CommentReactionType.AGREE);
      actorDistance = 350.01;
      await expect(join.execute(id, 80)).rejects.toThrow('OUT_OF_RANGE');
      await expect(write.execute(id, 'out of range', 79)).rejects.toThrow(
        'OUT_OF_RANGE',
      );
      await expect(
        react.execute(id, 80, PostReactionType.ENDED),
      ).rejects.toThrow('OUT_OF_RANGE');
      await expect(
        agree.execute(id, comment.commentId, 80, CommentReactionType.AGREE),
      ).rejects.toThrow('OUT_OF_RANGE');
    });
    it('expires at the 30-day boundary and publishes PostExpired via the real Outbox worker', async () => {
      const id = CAMPUS_POST_IDS[0];
      const deadline = (await posts.findOne({ postId: id }).lean())!
        .expiresAt as Date;
      const lifecycle = new PostLifecycle(store, partition);
      const worker = new ExpirationWorker(posts, lifecycle);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(deadline.getTime() - 1);
      await worker.runOnce();
      expect((await posts.findOne({ postId: id }).lean())!.status).toBe(
        'ACTIVE',
      );
      vi.setSystemTime(deadline);
      await worker.runOnce();
      expect((await posts.findOne({ postId: id }).lean())!.status).toBe(
        'EXPIRED',
      );
      await publisher.publishPending();
      const entries = await redis.xRange('post:events', '-', '+');
      expect(
        entries
          .map((e) => JSON.parse(e.message.data!))
          .some(
            (e) =>
              e.eventType === 'PostExpired' &&
              e.aggregateId === id &&
              e.post.expiresAt === deadline.toISOString(),
          ),
      ).toBe(true);
      vi.useRealTimers();
    });
    it('requires fresh, complete rollout evidence before apply', () => {
      const manifest = {
        authorId: 42,
        expectedNickname: '머준',
        location: {
          ...input,
          building: 'CAU_SEOUL_203',
          sourceUrl: 'https://example.test/local-fixture',
          verifiedAt: new Date().toISOString(),
        },
      };
      expect(validateCampusManifest(manifest, false).authorId).toBe(42);
      expect(() => validateCampusManifest(manifest, true)).toThrow('rollout');
    });
  },
);
