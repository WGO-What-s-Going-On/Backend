import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { createConnection, type Connection, Types } from 'mongoose';
import request from 'supertest';
import {
  Activities,
  ActivityController,
} from '../src/post/activity.controller.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import { GatewayAuthGuard } from '../src/gateway-auth.js';
import {
  PostSchema,
  CommentSchema,
  ReactionSchema,
  CommentReactionSchema,
  VoteSelectionSchema,
} from '../src/post/infrastructure/post.schemas.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
const actor = 777;
const kinds = [
  'POST',
  'COMMENT',
  'REACTION',
  'COMMENT_REACTION',
  'VOTE',
] as const;
type Kind = (typeof kinds)[number];
const collections = {
  POST: 'posts',
  COMMENT: 'post_comments',
  REACTION: 'post_reactions',
  COMMENT_REACTION: 'comment_reactions',
  VOTE: 'post_vote_selections',
};
const time = new Date('2026-11-01T00:00:00Z');
const closedAt = new Date('2026-11-02T00:00:00Z');

suite('Recent activity parent-post contract against MongoDB', () => {
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    connection = await createConnection(
      'mongodb://localhost:27017/?replicaSet=rs0',
      { dbName: `wgo_activity_${randomUUID().replaceAll('-', '')}` },
    ).asPromise();
    const models = [
      connection.model('Post', PostSchema, collections.POST),
      connection.model('Comment', CommentSchema, collections.COMMENT),
      connection.model('Reaction', ReactionSchema, collections.REACTION),
      connection.model(
        'CommentReaction',
        CommentReactionSchema,
        collections.COMMENT_REACTION,
      ),
      connection.model('VoteSelection', VoteSelectionSchema, collections.VOTE),
    ];
    const module = await Test.createTestingModule({
      controllers: [ActivityController],
      providers: [
        Activities,
        ...models.map((model) => ({
          provide: getModelToken(model.modelName),
          useValue: model,
        })),
        { provide: UserProfiles, useValue: {} },
        { provide: LOCATION_AUTHORIZATION, useValue: {} },
      ],
    })
      .overrideGuard(GatewayAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();
  }, 30000);

  beforeEach(async () => {
    await Promise.all(
      Object.values(collections).map((name) =>
        connection.collection(name).deleteMany({}),
      ),
    );
  });

  afterAll(async () => {
    await app?.close();
    if (connection) {
      await connection.dropDatabase();
      await connection.close();
    }
  });

  async function seed(
    kind: Kind,
    postId: string,
    status: 'ACTIVE' | 'EXPIRED' | 'DELETED' | null,
    date = time,
    id = new Types.ObjectId(),
  ) {
    if (status !== null) {
      await connection.collection(collections.POST).insertOne({
        _id: kind === 'POST' ? id : new Types.ObjectId(),
        postId,
        authorId: kind === 'POST' ? actor : 999,
        status,
        createdAt: date,
        updatedAt: date,
        closedAt,
      });
    }
    if (kind !== 'POST') {
      await connection.collection(collections[kind]).insertOne({
        _id: id,
        postId,
        authorId: actor,
        userId: actor,
        status: 'ACTIVE',
        commentId: `comment-${postId}`,
        removedAt: null,
        createdAt: kind === 'VOTE' ? new Date('2020-01-01') : date,
        updatedAt: date,
      });
    }
  }

  function page(cursor?: string) {
    return request(app.getHttpServer())
      .get('/api/v1/posts/me/activity')
      .set('x-user-id', String(actor))
      .query(cursor ? { cursor } : {})
      .expect(200);
  }

  it('returns stored ACTIVE and EXPIRED parent status and parent closure for every activity kind', async () => {
    for (const status of ['ACTIVE', 'EXPIRED'] as const) {
      for (const kind of kinds) await seed(kind, `${status}-${kind}`, status);
    }
    const { body } = await page();
    expect(body.items).toHaveLength(10);
    expect(body.nextCursor).toBeNull();
    for (const status of ['ACTIVE', 'EXPIRED']) {
      for (const kind of kinds) {
        expect(body.items).toContainEqual({
          kind,
          postId: `${status}-${kind}`,
          postStatus: status,
          commentId: kind === 'POST' ? null : `comment-${status}-${kind}`,
          createdAt: time.toISOString(),
          closedAt: closedAt.toISOString(),
          coverFocus: null,
          displayPosition: null,
        });
      }
    }
  });

  it('returns the parent cover focus for every activity kind', async () => {
    for (const status of ['ACTIVE', 'EXPIRED'] as const) {
      for (const kind of kinds) {
        const postId = `${status}-${kind}`;
        await seed(kind, postId, status);
        await connection
          .collection(collections.POST)
          .updateOne({ postId }, { $set: { coverFocus: { x: 0, y: 100 } } });
      }
    }
    const { body } = await page();
    expect(body.items).toHaveLength(10);
    for (const status of ['ACTIVE', 'EXPIRED']) {
      for (const kind of kinds) {
        expect(body.items).toContainEqual({
          kind,
          postId: `${status}-${kind}`,
          postStatus: status,
          commentId: kind === 'POST' ? null : `comment-${status}-${kind}`,
          createdAt: time.toISOString(),
          closedAt: closedAt.toISOString(),
          coverFocus: { x: 0, y: 100 },
          displayPosition: null,
        });
      }
    }
  });

  it('returns the parent display position independently of cover focus for every activity kind', async () => {
    const displayPosition = { x: -12.5, y: 0 };
    for (const status of ['ACTIVE', 'EXPIRED'] as const) {
      for (const kind of kinds) {
        const postId = `${status}-${kind}`;
        await seed(kind, postId, status);
        await connection
          .collection(collections.POST)
          .updateOne(
            { postId },
            { $set: { displayPosition, coverFocus: { x: 0, y: 100 } } },
          );
      }
    }
    const { body } = await page();
    expect(body.items).toHaveLength(10);
    for (const status of ['ACTIVE', 'EXPIRED']) {
      for (const kind of kinds) {
        expect(body.items).toContainEqual({
          kind,
          postId: `${status}-${kind}`,
          postStatus: status,
          commentId: kind === 'POST' ? null : `comment-${status}-${kind}`,
          createdAt: time.toISOString(),
          closedAt: closedAt.toISOString(),
          coverFocus: { x: 0, y: 100 },
          displayPosition,
        });
      }
    }
  });

  it('omits deleted and missing parents for all activity kinds', async () => {
    for (const kind of kinds) {
      await seed(kind, `deleted-${kind}`, 'DELETED');
      await seed(kind, `missing-${kind}`, null);
    }
    expect((await page()).body).toEqual({ items: [], nextCursor: null });
  });

  it('filters deleted parents before the page limit and preserves mixed-kind cursor order', async () => {
    for (let index = 0; index < 25; index++) {
      await seed(
        'COMMENT',
        `deleted-${index}`,
        'DELETED',
        new Date('2026-11-03'),
      );
    }
    const expected: string[] = [];
    for (let index = 0; index < 25; index++) {
      const kind = kinds[index % kinds.length]!;
      const postId = `valid-${index}`;
      expected.unshift(postId);
      await seed(
        kind,
        postId,
        index % 2 ? 'ACTIVE' : 'EXPIRED',
        time,
        new Types.ObjectId(index.toString(16).padStart(24, '0')),
      );
    }
    const first = (await page()).body;
    expect(first.items.map((item: { postId: string }) => item.postId)).toEqual(
      expected.slice(0, 20),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await page(first.nextCursor)).body;
    expect(second.items.map((item: { postId: string }) => item.postId)).toEqual(
      expected.slice(20),
    );
    expect(second.nextCursor).toBeNull();
  });
});
