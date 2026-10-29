import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import 'reflect-metadata';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { ExpirationWorker } from '../src/post/infrastructure/expiration.worker.js';
import { VoteWorker } from '../src/post/infrastructure/vote.worker.js';

const suite =
  process.env.RUN_INTEGRATION === '1' && process.env.RUN_WS_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('Post lifecycle -> Outbox -> WS', () => {
  let app: INestApplication;
  let db: Connection;
  let publisher: OutboxWorker;
  let gateway: any;
  const sockets: any[] = [];
  const redis = createClient({ url: 'redis://localhost:6380/11' });
  const inboxes: Array<Array<Record<string, any>>> = [];
  let socketUrl: string;
  let WebSocket: any;
  const connect = async () => {
    const socket = new WebSocket(socketUrl);
    sockets.push(socket);
    const inbox: Array<Record<string, any>> = [];
    inboxes.push(inbox);
    socket.on('message', (data: Buffer) =>
      inbox.push(JSON.parse(data.toString())),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return sockets.length - 1;
  };
  const command = async (
    i: number,
    type: string,
    boardId: string,
    extra = {},
  ) => {
    const requestId = randomUUID();
    sockets[i].send(
      JSON.stringify({
        version: 1,
        type,
        requestId,
        payload: { boardId, ...extra },
      }),
    );
    let result: Record<string, any> | undefined;
    await vi.waitFor(() => {
      result = inboxes[i]!.find((m) => m.requestId === requestId);
      expect(result).toBeDefined();
    });
    return result!;
  };
  const create = async () =>
    (
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set('X-User-Id', '123')
        .send({
          title: 'Lifecycle test',
          content: 'Test',
          category: 'INCIDENT',
          latitude: 37.5,
          longitude: 127,
          radiusM: 250,
        })
        .expect(201)
    ).body.postId as string;

  beforeAll(async () => {
    WebSocket = createRequire(
      new URL('../../../gateways/ws-gateway/package.json', import.meta.url),
    )('ws');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'MONGODB_URI',
      `mongodb://localhost:27017/ws_lifecycle_${randomUUID().replaceAll('-', '')}?replicaSet=rs0`,
    );
    vi.stubEnv('REDIS_URL', 'redis://localhost:6380/11');
    vi.stubEnv('SEMANTIC_ENABLED', 'false');
    vi.stubEnv('POST_MODERATION_CONSUMER_ENABLED', 'false');
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'ws-lifecycle-test-secret-at-least-32-bytes',
    );
    vi.stubEnv('JWT_ACCESS_ISSUER', 'wgo-user-service');
    vi.stubEnv('JWT_ACCESS_AUDIENCE', 'wgo-api');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    vi.stubEnv(
      'WS_SERVICE_PRIVATE_JWK',
      JSON.stringify({
        ...pair.privateKey.export({ format: 'jwk' }),
        alg: 'ES256',
        kid: 'ws-lifecycle',
      }),
    );
    vi.stubEnv(
      'POST_WS_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...pair.publicKey.export({ format: 'jwk' }),
            alg: 'ES256',
            kid: 'ws-lifecycle',
            iss: 'wgo-ws-gateway',
          },
        ],
      }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOCATION_AUTHORIZATION)
      .useValue({
        assertCanCreate: async () => {},
        assertCanJoin: async () => {},
      })
      .overrideProvider(OutboxWorker)
      .useValue({ wake() {} })
      .overrideProvider(UserProfiles)
      .useValue({
        names: async (ids: number[]) =>
          new Map(ids.map((id) => [id, `user-${id}`])),
      })
      .compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    await app.get(ExpirationWorker).onModuleDestroy();
    await app.get(VoteWorker).onModuleDestroy();
    db = app.get(getConnectionToken());
    for (const model of Object.values(db.models)) await model.syncIndexes();
    publisher = new OutboxWorker(app.get<Model<any>>(getModelToken('Outbox')));
    await redis.connect();
    await redis.flushDb();
    const { buildApp } = await import(
      new URL('../../../gateways/ws-gateway/dist/src/app.js', import.meta.url)
        .href
    );
    const { loadConfig } = await import(
      new URL(
        '../../../gateways/ws-gateway/dist/src/config.js',
        import.meta.url,
      ).href
    );
    const { HttpPostClient } = await import(
      new URL(
        '../../../gateways/ws-gateway/dist/src/realtime/post-client.js',
        import.meta.url,
      ).href
    );
    const config = loadConfig();
    config.postService.url = await app.getUrl();
    config.redisUrl = 'redis://localhost:6380/11';
    gateway = await buildApp({
      config,
      logger: false,
      enableEvents: true,
      postClient: new HttpPostClient(config.postService),
      authenticator: { authenticate: async () => ({ userId: '123' }) },
    });
    socketUrl =
      (await gateway.listen({ host: '127.0.0.1', port: 0 })).replace(
        /^http/,
        'ws',
      ) + '/ws/v1';
    await connect();
  }, 30000);
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway?.close();
    await publisher?.onModuleDestroy();
    await db?.dropDatabase();
    await app?.close();
    if (redis.isOpen) {
      await redis.flushDb();
      await redis.quit();
    }
    vi.unstubAllEnvs();
  });

  it('delivers real comment deletion and post expiration, then denies rejoin on a fresh connection', async () => {
    const postId = await create();
    expect(await command(0, 'board.join', postId)).toMatchObject({
      type: 'command.ack',
    });
    const created = await command(0, 'comment.create', postId, {
      content: 'removed body',
      mutationId: randomUUID(),
    });
    expect(created.type).toBe('command.result');
    const commentId = created.result.commentId;
    await publisher.publishPending();
    await vi.waitFor(() =>
      expect(inboxes[0]!.some((m) => m.type === 'comment.created')).toBe(true),
    );
    await app.get(PostLifecycle).deleteComment(postId, commentId, 123);
    await publisher.publishPending();
    await vi.waitFor(() =>
      expect(
        inboxes[0]!.find((m) => m.type === 'comment.deleted'),
      ).toMatchObject({
        activityVersion: 2,
        comment: { postId, commentId },
      }),
    );
    expect(
      JSON.stringify(inboxes[0]!.find((m) => m.type === 'comment.deleted')),
    ).not.toContain('removed body');
    expect((await command(0, 'comment.list', postId)).result.comments).toEqual(
      [],
    );
    await app
      .get(PostLifecycle)
      .scheduleExpiration(postId, new Date(Date.now() - 1000));
    await app.get(PostLifecycle).expire(postId);
    await publisher.publishPending();
    await vi.waitFor(() =>
      expect(
        inboxes[0]!.some(
          (m) => m.type === 'post.expired' && m.postId === postId,
        ),
      ).toBe(true),
    );
    expect(
      (
        await command(0, 'comment.create', postId, {
          content: 'late',
          mutationId: randomUUID(),
        })
      ).code,
    ).toBe('WS_BOARD_NOT_JOINED');
    const fresh = await connect();
    expect((await command(fresh, 'board.join', postId)).code).toBe(
      'WS_BOARD_JOIN_FORBIDDEN',
    );
  });

  it('delivers real post deletion and preserves an unrelated joined room', async () => {
    const postId = await create();
    const other = await create();
    await command(0, 'board.join', postId);
    await command(0, 'board.join', other);
    await publisher.publishPending();
    await app.get(PostLifecycle).deletePost(postId, 123);
    await publisher.publishPending();
    await vi.waitFor(() =>
      expect(
        inboxes[0]!.some(
          (m) => m.type === 'post.deleted' && m.postId === postId,
        ),
      ).toBe(true),
    );
    expect((await command(0, 'post.get', postId)).code).toBe(
      'WS_BOARD_NOT_JOINED',
    );
    expect((await command(0, 'post.get', other)).type).toBe('command.result');
  });
});
