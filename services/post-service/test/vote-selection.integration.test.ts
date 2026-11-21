import { randomUUID } from 'node:crypto';
import { createConnection } from 'mongoose';
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import {
  CommentSchema,
  CounterSchema,
  OutboxSchema,
  PostSchema,
  VoteSelectionSchema,
} from '../src/post/infrastructure/post.schemas.js';
import { serializePostEvent } from '../src/post/infrastructure/post-event-envelope.js';
const userModule = new URL(
  '../../user-service/src/rewards/post-event.ts',
  import.meta.url,
).href;
const { parsePostEvent } = await import(userModule);

const suite =
  process.env.RUN_TITLE_V3_INTEGRATION === '1' ? describe : describe.skip;
suite('ordinary vote selection outbox on isolated MongoDB', () => {
  const db = createConnection(),
    posts = db.model('Post', PostSchema),
    comments = db.model('Comment', CommentSchema),
    selections = db.model('VoteSelection', VoteSelectionSchema),
    outbox = db.model('Outbox', OutboxSchema),
    counters = db.model<{
      postId: string;
      metric: string;
      bucketId: number;
      count: number;
    }>('Counter', CounterSchema);
  let p: string, c: string, d: string;
  const make = () =>
    new MongooseVote(
      db,
      posts,
      comments,
      selections,
      outbox,
      {
        assertCanCreate: async () => {},
        assertCanJoin: async () => {},
        resolveRegion: async () => ({ code: '1159063000', name: 'test' }),
      },
      counters,
    );
  beforeAll(async () => {
    // Separate fixed loopback port avoids touching a developer's existing MongoDB.
    await db.openUri(
      `mongodb://127.0.0.1:27027/wgo_title_v3_${process.pid}_${Date.now()}?replicaSet=rs0`,
    );
    for (const model of Object.values(db.models)) await model.syncIndexes();
  }, 30000);
  afterAll(async () => {
    if (db.readyState === 1) await db.dropDatabase();
    await db.close();
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    await Promise.all(Object.values(db.models).map((m) => m.deleteMany({})));
    p = `post_${randomUUID()}`;
    c = `comment_${randomUUID()}`;
    d = `comment_${randomUUID()}`;
    const now = new Date();
    await posts.create({
      postId: p,
      authorId: 30,
      category: 'NEWS',
      title: 'Vote fixture',
      content: 'test',
      status: 'ACTIVE',
      radiusM: 150,
      locationSnapshot: { latitude: 37, longitude: 127 },
      createdAt: now,
      updatedAt: now,
      vote: {
        status: 'OPEN',
        candidates: [
          { commentId: c, authorId: 2, votes: 0 },
          { commentId: d, authorId: 3, votes: 0 },
        ],
        selectedAt: now,
        closedAt: null,
        winner: null,
      },
    });
  });
  it('is OFF by default without changing normal vote behavior', async () => {
    vi.stubEnv('POST_VOTE_SELECTION_EVENTS_ENABLED', '');
    const votes = make();
    await votes.choose(p, 1, c);
    await votes.cancel(p, 1);
    expect(
      await outbox.countDocuments({ eventType: 'PostVoteSelectionChanged' }),
    ).toBe(0);
    expect(
      (await selections.findOne({ postId: p, userId: 1 }).lean())?.commentId,
    ).toBeNull();
  });
  it('commits choices/cancellation and their monotonic events together, without emitting no-op duplicates', async () => {
    vi.stubEnv('POST_VOTE_SELECTION_EVENTS_ENABLED', 'true');
    const votes = make();
    await votes.choose(p, 1, c);
    await votes.choose(p, 1, c);
    await votes.choose(p, 1, d);
    await votes.cancel(p, 1);
    await votes.choose(p, 1, c);
    const rows = await outbox
      .find({ eventType: 'PostVoteSelectionChanged' })
      .sort({ createdAt: 1 })
      .lean();
    expect(rows).toHaveLength(4);
    const facts = rows.map(
      (row) =>
        parsePostEvent({
          eventId: row.eventId,
          eventType: row.eventType,
          data: serializePostEvent(row),
        })!,
    );
    expect(
      facts.map(
        (f: { voteSelection?: { commentId: string | null } }) =>
          f.voteSelection?.commentId,
      ),
    ).toEqual([c, d, null, c]);
    expect(facts.map((f: { version: number }) => f.version)).toEqual([
      1, 3, 4, 5,
    ]);
    expect((await votes.read(p, 1)).candidates.map((x) => x.votes)).toEqual([
      1, 0,
    ]);
  });
  it('rolls back a vote when its enabled outbox write fails', async () => {
    vi.stubEnv('POST_VOTE_SELECTION_EVENTS_ENABLED', 'true');
    const votes = make();
    const spy = vi
      .spyOn(outbox, 'create')
      .mockRejectedValueOnce(new Error('injected outbox failure'));
    await expect(votes.choose(p, 1, c)).rejects.toThrow(
      'injected outbox failure',
    );
    spy.mockRestore();
    expect(await selections.countDocuments({ postId: p })).toBe(0);
    expect((await votes.read(p, 1)).candidates.map((x) => x.votes)).toEqual([
      0, 0,
    ]);
  });
});
