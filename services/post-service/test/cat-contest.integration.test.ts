import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'mongoose';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCatContest } from '../src/post/application/create-cat-contest.js';
import { createCampusEvents } from '../src/post/application/create-campus-events.js';
import { createBalanceGames } from '../src/post/application/create-balance-games.js';
import {
  CreateComment,
  CreateCommentReaction,
  CreatePost,
  JoinPost,
} from '../src/post/application/commands.js';
import { HashPartitionStrategy } from '../src/post/application/partition.js';
import { LocationDeniedError } from '../src/post/application/errors.js';
import type { PostUnitOfWork } from '../src/post/application/ports.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { CommentReactionType } from '../src/post/domain/post.js';
import {
  CAT_CONTEST_EXPIRES_AT,
  CAT_CONTEST_LOCATION,
  CAT_CONTEST_POST_ID,
} from '../src/post/domain/cat-contest.js';
import { MongoosePostStore } from '../src/post/infrastructure/mongoose-post.store.js';
import * as schema from '../src/post/infrastructure/post.schemas.js';
import { MediaSchema } from '../src/post/media/media.schema.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { ExpirationWorker } from '../src/post/infrastructure/expiration.worker.js';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { ApplyModerationLifecycle } from '../src/post/application/moderation.js';

const suite =
  process.env.RUN_CAMPUS_INTEGRATION === '1' ? describe : describe.skip;
suite('one cat contest on isolated Mongo replica set / Redis DB13', () => {
  const db = createConnection();
  const model = (name: string, s: any, collection: string) =>
    db.model<any>(name, s, collection);
  const posts = model('Post', schema.PostSchema, 'posts'),
    comments = model('Comment', schema.CommentSchema, 'post_comments'),
    reactions = model('Reaction', schema.ReactionSchema, 'post_reactions'),
    commentReactions = model(
      'CommentReaction',
      schema.CommentReactionSchema,
      'post_comment_reactions',
    ),
    participants = model(
      'Participant',
      schema.ParticipantSchema,
      'post_participants',
    ),
    outbox = model('Outbox', schema.OutboxSchema, 'outbox_events'),
    counters = model('Counter', schema.CounterSchema, 'post_counters'),
    receipts = model(
      'ModerationReceipt',
      schema.ModerationReceiptSchema,
      'moderation_receipts',
    ),
    media = model('Media', MediaSchema, 'post_media'),
    selections = model(
      'VoteSelection',
      schema.VoteSelectionSchema,
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
    media as unknown as ConstructorParameters<typeof MongoosePostStore>[11],
  );
  const input = {
    authorId: 1,
    ...CAT_CONTEST_LOCATION,
    region: { code: '1159060500', name: 'local fixture' },
  };
  let distance = 350;
  const auth = {
    resolveRegion: async () => input.region,
    assertCanCreate: async () => {},
    assertCanJoin: async (
      _user: number,
      _post: string,
      _lat: number,
      _lon: number,
      radius: number,
    ) => {
      if (distance > radius) throw new LocationDeniedError('OUT_OF_RANGE');
    },
  };
  const partition = new HashPartitionStrategy();
  const write = new CreateComment(store, store, partition, auth);
  const redis = createClient({
    url: 'redis://127.0.0.1:16380/13',
    socket: { reconnectStrategy: false },
  });
  let publisher: OutboxWorker, normalId: string;
  const created = new Date('2026-11-27T12:00:00.000Z');
  beforeAll(async () => {
    await db.openUri(
      `mongodb://127.0.0.1:27029/wgo_cat_${randomUUID().replaceAll('-', '')}?replicaSet=rs0&directConnection=true`,
    );
    for (const m of Object.values(db.models)) await m.init();
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:16380/13');
    await redis.connect();
    if (await redis.dbSize()) throw Error('Dedicated Redis DB13 must be empty');
    publisher = new OutboxWorker(outbox);
    const originals = {
      ...input,
      latitude: 37.5047225,
      longitude: 126.9565323,
    };
    const originalTime = new Date('2026-11-24T12:52:53.893Z');
    await createCampusEvents(store, originals, false, originalTime);
    await createBalanceGames(
      store,
      originals,
      [
        {
          title: 'Local 송강 vs 종강',
          content: 'local',
          choices: ['송강', '종강'],
        },
        { title: 'local two', content: 'local', choices: ['A', 'B'] },
        { title: 'local three', content: 'local', choices: ['C', 'D'] },
      ],
      false,
      originalTime,
    );
    normalId = (
      await new CreatePost(store, auth).execute(
        {
          title: 'control',
          content: 'ordinary',
          category: 'NEWS',
          ...CAT_CONTEST_LOCATION,
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
  async function ready(type: 'IMAGE' | 'VIDEO' = 'IMAGE') {
    const id = `media_${randomUUID()}`;
    await media.create({
      mediaId: id,
      ownerId: 79,
      objectKey: id,
      uploadKey: id,
      type,
      contentType: type === 'IMAGE' ? 'image/png' : 'video/mp4',
      sizeBytes: 24,
      checksum: 'local',
      status: 'READY',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    });
    return id;
  }
  it('rolls back an Outbox failure, dry-runs without writes, and creates/retries only one new identity', async () => {
    const before = await posts.find().sort({ postId: 1 }).lean();
    const inventory = [
      await posts.countDocuments(),
      await counters.countDocuments(),
      await outbox.countDocuments(),
    ];
    const fail: PostUnitOfWork = {
      execute: (work) =>
        store.execute((tx) =>
          work({
            ...tx,
            commands: new Proxy(tx.commands, {
              get(target, key) {
                if (key === 'appendEvent')
                  return async () => {
                    throw Error('local outbox failure');
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          }),
        ),
    };
    await expect(createCatContest(fail, input, false, created)).rejects.toThrow(
      'local outbox failure',
    );
    await createCatContest(store, input, true, created);
    expect([
      await posts.countDocuments(),
      await counters.countDocuments(),
      await outbox.countDocuments(),
    ]).toEqual(inventory);
    await Promise.all([
      createCatContest(store, input, false, created),
      createCatContest(store, input, false, created),
    ]);
    expect(
      await posts
        .find({ postId: { $ne: CAT_CONTEST_POST_ID } })
        .sort({ postId: 1 })
        .lean(),
    ).toEqual(before);
    const row = (await posts.findOne({ postId: CAT_CONTEST_POST_ID }).lean())!;
    expect(row).toMatchObject({
      authorId: 1,
      status: 'ACTIVE',
      radiusM: 350,
      locationSnapshot: CAT_CONTEST_LOCATION,
      vote: { status: 'NONE' },
      createdAt: created,
      expiresAt: new Date(CAT_CONTEST_EXPIRES_AT),
    });
    expect(
      await outbox.countDocuments({
        aggregateId: CAT_CONTEST_POST_ID,
        eventType: 'PostCreated',
      }),
    ).toBe(1);
    await createCatContest(
      store,
      input,
      false,
      new Date('2026-11-28T12:00:00Z'),
    );
    expect(await posts.findOne({ postId: CAT_CONTEST_POST_ID }).lean()).toEqual(
      row,
    );
    await expect(
      createCatContest(store, { ...input, authorId: 2 }, false),
    ).rejects.toThrow('author/location');
  });
  it('requires exactly one image per contest comment and rolls back invalid attachments; ordinary comments keep multi-media support', async () => {
    await new JoinPost(store, store, auth, partition).execute(
      CAT_CONTEST_POST_ID,
      79,
    );
    const first = await ready(),
      second = await ready(),
      video = await ready('VIDEO');
    const before = [
      await comments.countDocuments(),
      await outbox.countDocuments(),
    ];
    await expect(
      write.execute(CAT_CONTEST_POST_ID, 'no photo', 79),
    ).rejects.toThrow('one photo');
    await expect(
      write.execute(CAT_CONTEST_POST_ID, 'two', 79, undefined, [first, second]),
    ).rejects.toThrow('one photo');
    await expect(
      write.execute(CAT_CONTEST_POST_ID, 'video', 79, undefined, [video]),
    ).rejects.toThrow('Media is not ready');
    expect([
      await comments.countDocuments(),
      await outbox.countDocuments(),
    ]).toEqual(before);
    expect(await media.countDocuments({ status: 'ATTACHED' })).toBe(0);
    const comment = await write.execute(
      CAT_CONTEST_POST_ID,
      'photo entry',
      79,
      undefined,
      [first],
    );
    expect(await media.findOne({ mediaId: first }).lean()).toMatchObject({
      status: 'ATTACHED',
      postId: CAT_CONTEST_POST_ID,
      commentId: comment.commentId,
      ownerId: 79,
    });
    await new CreateCommentReaction(store, store, auth).execute(
      CAT_CONTEST_POST_ID,
      comment.commentId,
      80,
      CommentReactionType.AGREE,
    );
    expect(
      await comments.findOne({ commentId: comment.commentId }).lean(),
    ).toMatchObject({
      authorId: 79,
      mediaIds: [first],
      reactionCounts: { AGREE: 1 },
    });
    distance = 350.01;
    await expect(
      write.execute(CAT_CONTEST_POST_ID, 'outside', 79, undefined, [second]),
    ).rejects.toThrow('OUT_OF_RANGE');
    await expect(
      new CreateCommentReaction(store, store, auth).execute(
        CAT_CONTEST_POST_ID,
        comment.commentId,
        81,
        CommentReactionType.AGREE,
      ),
    ).rejects.toThrow('OUT_OF_RANGE');
    distance = 150;
    await new JoinPost(store, store, auth, partition).execute(normalId, 79);
    const image = await ready();
    await write.execute(
      normalId,
      'unchanged ordinary multi-media',
      79,
      undefined,
      [second, image, video],
    );
    expect(await posts.findOne({ postId: normalId }).lean()).toMatchObject({
      vote: { status: 'PENDING' },
    });
  });
  it('ignores early BOARD_CLOSED only for this policy and expires via the existing worker/outbox at the shared deadline', async () => {
    await new ApplyModerationLifecycle(store).execute({
      postId: CAT_CONTEST_POST_ID,
      eventId: `evt_${randomUUID()}`,
      eventType: 'BOARD_CLOSED',
      occurredAt: new Date(),
      correlationId: 'local',
    });
    const votes = new MongooseVote(
      db,
      posts,
      comments,
      selections,
      outbox,
      auth,
      counters as unknown as ConstructorParameters<typeof MongooseVote>[6],
    );
    await votes.selectDue(CAT_CONTEST_POST_ID);
    expect((await votes.read(CAT_CONTEST_POST_ID)).status).toBe('NONE');
    const worker = new ExpirationWorker(
      posts,
      new PostLifecycle(store, partition),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(CAT_CONTEST_EXPIRES_AT) - 1);
    await worker.runOnce();
    expect(
      await posts.findOne({ postId: CAT_CONTEST_POST_ID }).lean(),
    ).toMatchObject({ status: 'ACTIVE' });
    vi.setSystemTime(new Date(CAT_CONTEST_EXPIRES_AT));
    await worker.runOnce();
    expect(
      await posts.findOne({ postId: CAT_CONTEST_POST_ID }).lean(),
    ).toMatchObject({ status: 'EXPIRED', vote: { status: 'NONE' } });
    await expect(
      write.execute(CAT_CONTEST_POST_ID, 'late', 79, undefined, [
        `media_${randomUUID()}`,
      ]),
    ).rejects.toThrow();
    await publisher.publishPending();
    const entries = await redis.xRange('post:events', '-', '+');
    const events = entries.map((v) => JSON.parse(v.message.data!));
    expect(
      events.find(
        (e) =>
          e.aggregateId === CAT_CONTEST_POST_ID &&
          e.eventType === 'PostExpired',
      )?.post.expiresAt,
    ).toBe(CAT_CONTEST_EXPIRES_AT);
    expect(
      await outbox.countDocuments({
        aggregateId: CAT_CONTEST_POST_ID,
        eventType: { $in: ['PostVoteWon', 'PostVoteCandidateSelected'] },
      }),
    ).toBe(0);
    expect((await createCatContest(store, input, false))[0]).toMatchObject({
      created: false,
      status: 'EXPIRED',
    });
    vi.useRealTimers();
  });
});
