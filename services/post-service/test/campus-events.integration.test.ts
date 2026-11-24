import 'reflect-metadata';
import { createBalanceGames } from '../src/post/application/create-balance-games.js';
import { ApplyContentDecision } from '../src/post/application/content-decision.js';
import { parseContentDecision } from '../src/post/infrastructure/content-decision-event.js';
import { decisionFields } from './helpers/content-decision.js';
import { Activities } from '../src/post/activity.controller.js';
import type { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import { BALANCE_POST_IDS } from '../src/post/domain/campus-events.js';
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
    const balanceInput = {
      ...input,
      authorId: 1,
      latitude: 37.5047225,
      longitude: 126.9565323,
    };
    const copies = [
      {
        title: 'LOCAL 송강 vs 종강',
        content: 'Local fixture, not approved copy.',
        choices: ['송강', '종강'] as [string, string],
      },
      {
        title: 'LOCAL two',
        content: 'Synthetic fixture two.',
        choices: ['A2', 'B2'] as [string, string],
      },
      {
        title: 'LOCAL three',
        content: 'Synthetic fixture three.',
        choices: ['A3', 'B3'] as [string, string],
      },
    ];
    const fixedVotes = new MongooseVote(
      db,
      posts,
      comments,
      selections,
      outbox,
      auth,
      counters as unknown as ConstructorParameters<typeof MongooseVote>[6],
    );
    it('creates only three reserved OPEN polls atomically; dry-run and concurrent retry preserve existing data', async () => {
      const before = await posts.find().sort({ postId: 1 }).lean();
      const inventory = [
        await posts.countDocuments(),
        await counters.countDocuments(),
        await comments.countDocuments(),
        await outbox.countDocuments(),
      ];
      await createBalanceGames(store, balanceInput, copies);
      expect([
        await posts.countDocuments(),
        await counters.countDocuments(),
        await comments.countDocuments(),
        await outbox.countDocuments(),
      ]).toEqual(inventory);
      await Promise.all([
        createBalanceGames(store, balanceInput, copies, false),
        createBalanceGames(store, balanceInput, copies, false),
      ]);
      expect(
        await posts
          .find({ postId: { $nin: [...BALANCE_POST_IDS] } })
          .sort({ postId: 1 })
          .lean(),
      ).toEqual(before);
      expect(await comments.countDocuments()).toBe(inventory[2]);
      for (const id of BALANCE_POST_IDS) {
        const p = (await posts.findOne({ postId: id }).lean())!;
        expect(p.vote).toMatchObject({
          status: 'OPEN',
          kind: 'FIXED_AB',
          candidates: [
            { commentId: 'option_A', votes: 0 },
            { commentId: 'option_B', votes: 0 },
          ],
        });
        expect(p.expiresAt.getTime() - p.createdAt.getTime()).toBe(
          CAMPUS_DURATION_MS,
        );
        await fixedVotes.selectDue(id);
      }
      expect(
        await outbox.countDocuments({
          aggregateId: { $in: [...BALANCE_POST_IDS] },
          eventType: 'PostCreated',
        }),
      ).toBe(3);
      expect(
        await outbox.countDocuments({
          aggregateId: { $in: [...BALANCE_POST_IDS] },
          eventType: 'PostVoteCandidateSelected',
        }),
      ).toBe(0);
      expect(
        (await posts.findOne({ postId: CAMPUS_POST_IDS[1] }).lean())!.vote
          .status,
      ).toBe('NONE');
    });
    it('rejects copy conflicts and rolls back the other reserved identities', async () => {
      const before = await posts.find().sort({ postId: 1 }).lean();
      await expect(
        createBalanceGames(
          store,
          balanceInput,
          copies.map((copy, i) =>
            i === 2 ? { ...copy, title: 'changed' } : copy,
          ),
          false,
        ),
      ).rejects.toThrow('conflicts');
      expect(await posts.find().sort({ postId: 1 }).lean()).toEqual(before);
      await expect(
        createBalanceGames(
          store,
          { ...balanceInput, authorId: 2 },
          copies,
          false,
        ),
      ).rejects.toThrow('verified author');
    });
    it('reuses unique per-user selections: duplicate, concurrent change, cancel, counts, and no fabricated activity', async () => {
      const id = BALANCE_POST_IDS[0];
      actorDistance = 350;
      const before = await outbox.countDocuments();
      await Promise.all(
        Array.from({ length: 4 }, () => fixedVotes.choose(id, 101, 'option_A')),
      );
      expect(await selections.countDocuments({ postId: id, userId: 101 })).toBe(
        1,
      );
      expect(
        (await fixedVotes.read(id, 101)).candidates.map((c) => c.votes),
      ).toEqual([1, 0]);
      await fixedVotes.choose(id, 101, 'option_B');
      expect(
        (await fixedVotes.read(id, 101)).candidates.map((c) => c.votes),
      ).toEqual([0, 1]);
      actorDistance = 351;
      await expect(fixedVotes.choose(id, 101, 'option_A')).rejects.toThrow(
        'OUT_OF_RANGE',
      );
      await fixedVotes.cancel(id, 101); // Existing cancellation remains location independent.
      await fixedVotes.cancel(id, 101);
      expect(
        (await fixedVotes.read(id, 101)).candidates.map((c) => c.votes),
      ).toEqual([0, 0]);
      expect((await fixedVotes.read(id, 101)).mySelection).toBeNull();
      actorDistance = 350;
      await Promise.all([
        fixedVotes.choose(id, 101, 'option_A'),
        fixedVotes.choose(id, 101, 'option_B'),
        fixedVotes.cancel(id, 101),
      ]);
      const concurrent = await fixedVotes.read(id, 101);
      expect(concurrent.candidates.map((c) => c.votes)).toEqual(
        concurrent.candidates.map((c) =>
          c.commentId === concurrent.mySelection ? 1 : 0,
        ),
      );
      await fixedVotes.cancel(id, 101);
      expect(await outbox.countDocuments()).toBe(before);
      expect(
        await comments.countDocuments({
          postId: { $in: [...BALANCE_POST_IDS] },
        }),
      ).toBe(0);
      await fixedVotes.choose(id, 102, 'option_A');
      await fixedVotes.choose(id, 103, 'option_A');
      await expect(fixedVotes.choose(id, 104, 'option_C')).rejects.toThrow();
    });
    it('retains fixed polls across old lifecycle closure events and 350m comments/reactions', async () => {
      const id = BALANCE_POST_IDS[0];
      await new ApplyModerationLifecycle(store).execute({
        postId: id,
        eventId: 'evt_local_balance_old_close',
        eventType: 'BOARD_CLOSED',
        occurredAt: new Date(),
        correlationId: 'local-old-pod',
      });
      expect((await posts.findOne({ postId: id }).lean())!.status).toBe(
        'ACTIVE',
      );
      actorDistance = 350;
      await new JoinPost(store, store, auth, partition).execute(id, 79);
      const comment = await new CreateComment(
        store,
        store,
        partition,
        auth,
      ).execute(id, 'Real local test comment', 79);
      await new CreateCommentReaction(store, store, auth).execute(
        id,
        comment.commentId,
        79,
        CommentReactionType.AGREE,
      );
      await new CreateReaction(store, store, partition, auth).execute(
        id,
        79,
        PostReactionType.ENDED,
      );
      actorDistance = 350.01;
      await expect(
        new CreateComment(store, store, partition, auth).execute(
          id,
          'outside',
          79,
        ),
      ).rejects.toThrow('OUT_OF_RANGE');
      await expect(
        new CreateCommentReaction(store, store, auth).execute(
          id,
          comment.commentId,
          80,
          CommentReactionType.AGREE,
        ),
      ).rejects.toThrow('OUT_OF_RANGE');
      await expect(
        new CreateReaction(store, store, partition, auth).execute(
          id,
          80,
          PostReactionType.HELPFUL,
        ),
      ).rejects.toThrow('OUT_OF_RANGE');
    });
    it('closes with a fixed winner at exactly 30 days, blocks votes before worker catch-up, emits expiry but no rewards', async () => {
      const id = BALANCE_POST_IDS[0];
      const before = (await posts.findOne({ postId: id }).lean())!;
      const deadline = before.expiresAt as Date;
      const worker = new ExpirationWorker(
        posts,
        new PostLifecycle(store, partition),
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(deadline.getTime() - 1);
      await worker.runOnce();
      expect((await posts.findOne({ postId: id }).lean())!.vote.status).toBe(
        'OPEN',
      );
      vi.setSystemTime(deadline);
      await expect(fixedVotes.choose(id, 105, 'option_B')).rejects.toThrow(
        'not open',
      );
      await expect(fixedVotes.cancel(id, 102)).rejects.toThrow('not open');
      await worker.runOnce();
      const p = (await posts.findOne({ postId: id }).lean())!;
      expect(p.status).toBe('EXPIRED');
      expect(p.vote).toMatchObject({
        status: 'CLOSED',
        winner: { commentId: 'option_A', votes: 2 },
      });
      expect(p.vote.closedAt).toEqual(deadline);
      const activity = new Activities(
        posts,
        comments,
        reactions,
        commentReactions,
        selections,
        { names: async () => new Map() } as unknown as UserProfiles,
      );
      expect((await activity.stats(1)).picks).toBe(0);
      expect((await activity.ranking(1, input.region.code)).items).toEqual([]);
      expect(
        await outbox.countDocuments({
          aggregateId: { $in: [...BALANCE_POST_IDS] },
          eventType: { $in: ['PostVoteWon', 'PostVoteCandidateSelected'] },
        }),
      ).toBe(0);
      await createBalanceGames(store, balanceInput, copies, false);
      expect(await posts.findOne({ postId: id }).lean()).toEqual(p);
      await publisher.publishPending();
      const entries = (await redis.xRange('post:events', '-', '+')).map((e) =>
        JSON.parse(e.message.data!),
      );
      expect(
        entries.filter(
          (e) =>
            e.eventType === 'PostExpired' &&
            BALANCE_POST_IDS.includes(e.aggregateId),
        ).length,
      ).toBe(3);
      vi.useRealTimers();
    });
    it('hidden or deleted balance posts still reject voting and never emit winner rewards', async () => {
      // A separate local transaction recreates a fixture after the expiry test.
      const id = BALANCE_POST_IDS[1];
      const reset = new Date();
      await posts.updateOne(
        { postId: id },
        {
          $set: {
            status: 'ACTIVE',
            createdAt: reset,
            expiresAt: new Date(reset.getTime() + CAMPUS_DURATION_MS),
            'vote.status': 'OPEN',
          },
        },
      );
      actorDistance = 350;
      await fixedVotes.choose(id, 111, 'option_B');
      const version = (await posts.findOne({ postId: id }).lean())!.postVersion;
      expect(
        await new ApplyContentDecision(store).execute(
          parseContentDecision(
            decisionFields(id, { targetType: 'POST', postVersion: version }),
          )!,
        ),
      ).toBe('APPLIED');
      expect((await posts.findOne({ postId: id }).lean())!.status).toBe(
        'HIDDEN',
      );
      const hidden = await posts.findOne({ postId: id }).lean();
      await createBalanceGames(store, balanceInput, copies, false);
      expect(await posts.findOne({ postId: id }).lean()).toEqual(hidden);
      await expect(fixedVotes.read(id, 111)).rejects.toThrow('not found');
      await expect(fixedVotes.choose(id, 111, 'option_A')).rejects.toThrow(
        'not found',
      );
      await new PostLifecycle(store, partition).deletePost(id, 1);
      await expect(fixedVotes.choose(id, 111, 'option_A')).rejects.toThrow();
      expect((await posts.findOne({ postId: id }).lean())!.vote.status).toBe(
        'CANCELLED',
      );
      expect(
        await outbox.countDocuments({
          aggregateId: id,
          eventType: 'PostVoteWon',
        }),
      ).toBe(0);
    });
    it('ordinary polls still select real comments, change/cancel votes, close and emit winner rewards', async () => {
      actorDistance = 150;
      const id = (
        await new CreatePost(store, auth).execute(
          {
            title: 'ordinary regression',
            content: 'local control',
            category: 'NEWS',
            latitude: input.latitude,
            longitude: input.longitude,
            radiusM: 150,
          },
          99,
        )
      ).postId;
      await new JoinPost(store, store, auth, partition).execute(id, 79);
      const write = new CreateComment(store, store, partition, auth);
      const first = await write.execute(id, 'ordinary A', 79);
      const second = await write.execute(id, 'ordinary B', 79);
      await comments.updateMany(
        { postId: id },
        { $set: { 'reactionCounts.HELPFUL': 20 } },
      );
      await posts.updateOne(
        { postId: id },
        { $set: { 'counters.viewCount': 100 } },
      );
      await fixedVotes.selectDue(id);
      expect((await fixedVotes.read(id)).status).toBe('OPEN');
      await fixedVotes.choose(id, 201, first.commentId);
      await fixedVotes.choose(id, 201, second.commentId);
      await fixedVotes.cancel(id, 201);
      await fixedVotes.choose(id, 201, first.commentId);
      await new PostLifecycle(store, partition).deletePost(id, 99);
      expect((await posts.findOne({ postId: id }).lean())!.vote.status).toBe(
        'CLOSED',
      );
      expect(
        await outbox.countDocuments({
          aggregateId: id,
          eventType: 'PostVoteCandidateSelected',
        }),
      ).toBe(2);
      expect(
        await outbox.countDocuments({
          aggregateId: id,
          eventType: 'PostVoteWon',
        }),
      ).toBe(1);
    });
  },
);
