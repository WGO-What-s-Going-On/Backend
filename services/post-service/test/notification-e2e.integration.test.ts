import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import type { Connection, Model } from 'mongoose';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { SemanticWorker } from '../src/post/semantic/worker.js';
import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';

// Build sibling services first. Dynamic imports keep independent service dependency trees intact.
const load = (service: string, path: string) =>
  import(new URL(`../../${service}/dist/${path}`, import.meta.url).href);
it.skipIf(process.env.RUN_NOTIFICATION_E2E !== '1')(
  'real Post Mongo transaction/outbox → Redis → Notification PostgreSQL/FCM with authenticated User block authority',
  async () => {
    const suffix = randomUUID().replaceAll('-', ''),
      mongoName = `wgo_notification_e2e_${suffix}`,
      userName = `wgo_notify_e2e_u_${suffix}`,
      schema = `notification_e2e_${suffix}`,
      redisUrl = 'redis://127.0.0.1:6382/14';
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'MONGODB_URI',
      `mongodb://localhost:27017/${mongoName}?replicaSet=rs0`,
    );
    vi.stubEnv('REDIS_URL', redisUrl);
    vi.stubEnv('SEMANTIC_MODEL_ENABLED', 'false');
    vi.stubEnv('NEARBY_NOTIFICATIONS_ENABLED', 'false');
    const { PostgresDatabase } = await load(
        'notification-service',
        'persistence/postgres.database.js',
      ),
      { migrate } = await load('notification-service', 'persistence/schema.js');
    const admin = new PostgresDatabase(
      new ConfigService({
        database: {
          connectionString:
            'postgres://wgo:wgo@127.0.0.1:5432/wgo_notification',
        },
      }),
    );
    const sql = new PostgresDatabase(
      new ConfigService({
        database: {
          connectionString:
            'postgres://wgo:wgo@127.0.0.1:5432/wgo_notification',
          options: `-c search_path=${schema}`,
        },
      }),
    );
    const redis = createClient({ url: redisUrl });
    redis.on('error', () => undefined);
    await redis.connect();
    if ((await redis.dbSize()) !== 0)
      throw new Error('E2E Redis DB must be empty; existing data preserved');
    let app: INestApplication | undefined,
      userApp: INestApplication | undefined,
      db: Connection | undefined,
      userDB: any,
      state: any,
      consumer: any,
      publisher: OutboxWorker | undefined;
    try {
      await admin.pool.query(`CREATE SCHEMA ${schema}`);
      await migrate(sql.pool);
      await admin.pool.query(`CREATE DATABASE ${userName}`);
      const userRequire = createRequire(
          new URL('../../user-service/package.json', import.meta.url),
        ),
        { DataSource } = userRequire('typeorm');
      userDB = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        username: 'wgo',
        password: 'wgo',
        database: userName,
      });
      await userDB.initialize();
      const { InitialUserServiceSchema1789990707351 } = await load(
        'user-service',
        'database/migrations/1789990707351-InitialUserServiceSchema.js',
      );
      const runner = userDB.createQueryRunner();
      await new InitialUserServiceSchema1789990707351().up(runner);
      await runner.release();
      await userDB.query(
        "INSERT INTO users(id,nickname,status,created_at,updated_at) SELECT n,'e2e-'||n,'ACTIVE',now(),now() FROM generate_series(1,3) n",
      );
      const notificationKey = generateKeyPairSync('ec', {
          namedCurve: 'P-256',
        }),
        gatewayKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      vi.stubEnv(
        'USER_NOTIFICATION_TRUSTED_JWKS',
        JSON.stringify({
          keys: [
            {
              ...notificationKey.publicKey.export({ format: 'jwk' }),
              alg: 'ES256',
              iss: 'wgo-notification-service',
              kid: 'notification-e2e',
            },
          ],
        }),
      );
      vi.stubEnv(
        'USER_HTTP_GATEWAY_TRUSTED_JWKS',
        JSON.stringify({
          keys: [
            {
              ...gatewayKey.publicKey.export({ format: 'jwk' }),
              alg: 'ES256',
              iss: 'wgo-http-gateway',
              kid: 'gateway-e2e',
            },
          ],
        }),
      );
      const { NotificationBlocksController } = await load(
          'user-service',
          'users/notification-blocks.controller.js',
        ),
        { GatewayAuthGuard } = await load(
          'user-service',
          'http-auth/gateway-auth.guard.js',
        );
      const userModule = await Test.createTestingModule({
        controllers: [NotificationBlocksController],
        providers: [
          { provide: DataSource, useValue: userDB },
          { provide: APP_GUARD, useClass: GatewayAuthGuard },
        ],
      }).compile();
      userApp = userModule.createNestApplication();
      await userApp.listen(0, '127.0.0.1');
      const { NotificationBlockChecker } = await load(
        'notification-service',
        'notification/block-checker.js',
      );
      const blocks = new NotificationBlockChecker(
        new ConfigService({
          blocks: {
            url: `${await userApp.getUrl()}/internal/notifications/blocks/check`,
            privateJwk: JSON.stringify({
              ...notificationKey.privateKey.export({ format: 'jwk' }),
              alg: 'ES256',
              kid: 'notification-e2e',
            }),
          },
        }),
      );
      const { PostgresEventStore } = await load(
          'notification-service',
          'persistence/postgres-event.store.js',
        ),
        { PostEventHandler } = await load(
          'notification-service',
          'event-consumer/post-event.handler.js',
        ),
        { PostEventConsumer } = await load(
          'notification-service',
          'event-consumer/post-event.consumer.js',
        ),
        { NotificationState } = await load(
          'notification-service',
          'redis/notification-state.js',
        ),
        { PostgresNotificationRepository } = await load(
          'notification-service',
          'persistence/postgres-notification.repository.js',
        );
      state = NotificationState.fromUrl(redisUrl);
      const store = new PostgresEventStore(sql, blocks),
        send = vi.fn().mockResolvedValue({
          attempted: 1,
          succeeded: 1,
          failed: 0,
          invalidTokens: [],
          retryTokens: [],
        }),
        handler = new PostEventHandler(
          store,
          state,
          { send },
          undefined,
          blocks,
        );
      consumer = new PostEventConsumer(
        new ConfigService({
          redis: { url: redisUrl, pendingIdleMs: 0, blockMs: 1 },
        }),
        handler,
        undefined,
        sql,
      );
      await consumer.worker.initialize();
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(LOCATION_AUTHORIZATION)
        .useValue({
          assertCanCreate: async () => {},
          assertCanJoin: async () => {},
          resolveRegion: async () => ({
            code: '1159053000',
            name: '테스트 지역',
          }),
        })
        .overrideProvider(UserProfiles)
        .useValue({ names: async () => new Map() })
        .overrideProvider(OutboxWorker)
        .useValue({ wake() {} })
        .overrideProvider(SemanticWorker)
        .useValue({})
        .compile();
      app = module.createNestApplication();
      await app.listen(0, '127.0.0.1');
      db = app.get<Connection>(getConnectionToken());
      const outbox = app.get<Model<any>>(getModelToken('Outbox'));
      publisher = new OutboxWorker(outbox);
      const repo = new PostgresNotificationRepository(sql),
        items = async (id: string) => (await repo.list(id, 100)).items;
      const flush = async () => {
        await publisher!.publishPending();
        for (let n = 0; n < 10; n++) {
          await consumer.pollOnce();
          if (
            (await redis.xPending('post:events', 'post-notification'))
              .pending === 0
          )
            break;
        }
        expect(
          (await redis.xPending('post:events', 'post-notification')).pending,
        ).toBe(0);
      };
      const post = await request(app.getHttpServer())
          .post('/api/v1/posts')
          .set('x-user-id', '1')
          .send({
            title: 'E2E',
            content: 'not a push body',
            category: 'INCIDENT',
            latitude: 37.5,
            longitude: 127,
            radiusM: 150,
            anonymous: true,
          })
          .expect(201),
        base = `/api/v1/posts/${post.body.postId}`;
      const moderationKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      vi.stubEnv(
        'POST_MODERATION_TRUSTED_JWKS',
        JSON.stringify({
          keys: [
            {
              ...moderationKey.publicKey.export({ format: 'jwk' }),
              alg: 'ES256',
              iss: 'wgo-moderation-service',
              kid: 'moderation-e2e',
            },
          ],
        }),
      );
      vi.stubEnv(
        'MODERATION_SERVICE_PRIVATE_JWK',
        JSON.stringify({
          ...moderationKey.privateKey.export({ format: 'jwk' }),
          alg: 'ES256',
          kid: 'moderation-e2e',
        }),
      );
      vi.stubEnv(
        'MODERATION_POST_REPORT_TARGET_URL',
        `${await app.getUrl()}/internal/v1/moderation/report-target`,
      );
      const { ReportTarget } = await load(
          'moderation-service',
          'reports/report-target.js',
        ),
        reportTarget = new ReportTarget();
      await reportTarget.verify({
        targetType: 'POST',
        postId: post.body.postId,
        reason: 'SPAM',
      });
      for (const id of ['2', '3'])
        await request(app.getHttpServer())
          .post(`${base}/participants`)
          .set('x-user-id', id)
          .send({})
          .expect(201);
      const parent = await request(app.getHttpServer())
        .post(`${base}/comments`)
        .set('x-user-id', '3')
        .send({ content: 'private parent body' })
        .expect(201);
      const reply = await request(app.getHttpServer())
        .post(`${base}/comments`)
        .set('x-user-id', '2')
        .send({
          content: 'private reply body',
          parentCommentId: parent.body.commentId,
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${base}/comments/${parent.body.commentId}/reactions`)
        .set('x-user-id', '2')
        .send({ type: 'HELPFUL' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${base}/reactions`)
        .set('x-user-id', '2')
        .send({ type: 'CURIOUS' })
        .expect(201);
      await flush();
      expect(
        await outbox
          .findOne({ 'payload.comment.commentId': reply.body.commentId })
          .lean(),
      ).toMatchObject({
        status: 'PUBLISHED',
        payload: { parentCommentAuthorId: 3 },
      });
      expect((await items('3')).map((n: any) => n.type).sort()).toEqual([
        'COMMENT_REACTED',
        'COMMENT_REPLIED',
      ]);
      expect((await items('1')).map((n: any) => n.type).sort()).toEqual([
        'COMMENT_REPLIED',
        'POST_COMMENTED',
        'POST_REACTED',
      ]);
      expect(JSON.stringify(send.mock.calls)).not.toContain(
        'private reply body',
      );
      const sent = send.mock.calls.length,
        original = (await redis.xRange('post:events', '-', '+')).find(
          (row) => row.message.eventType === 'PostCommentCreated',
        )!;
      await redis.xAdd('post:events', '*', original.message);
      await consumer.pollOnce();
      expect(send).toHaveBeenCalledTimes(sent);
      await userDB.query('INSERT INTO user_blocks VALUES(3,2,now())');
      await request(app.getHttpServer())
        .post(`${base}/comments`)
        .set('x-user-id', '2')
        .send({
          content: 'blocked reply',
          parentCommentId: parent.body.commentId,
        })
        .expect(201);
      await flush();
      expect(
        (await items('3')).find((n: any) => n.type === 'COMMENT_REPLIED').count,
      ).toBe(1);
      await request(app.getHttpServer())
        .delete(`${base}/comments/${parent.body.commentId}/reactions/HELPFUL`)
        .set('x-user-id', '2')
        .expect(204);
      await flush();
      expect(
        (await items('3')).some((n: any) => n.type === 'COMMENT_REACTED'),
      ).toBe(false);
      await request(app.getHttpServer())
        .delete(`${base}/comments/${parent.body.commentId}`)
        .set('x-user-id', '3')
        .expect(204);
      await flush();
      expect(await items('3')).toHaveLength(0);
      await request(app.getHttpServer())
        .put(`${base}/closed`)
        .set('x-user-id', '1')
        .send({ closed: true })
        .expect(204);
      await flush();
      expect(
        (await items('1')).some((n: any) => n.type === 'POST_CLOSED'),
      ).toBe(true);
      expect(
        (await sql.pool.query('SELECT * FROM notification_event_inbox'))
          .rowCount,
      ).toBe(await outbox.countDocuments({ status: 'PUBLISHED' }));
      await expect(
        reportTarget.verify({
          targetType: 'POST',
          postId: post.body.postId,
          reason: 'SPAM',
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await publisher?.onModuleDestroy();
      await consumer?.onModuleDestroy();
      await state?.onModuleDestroy();
      if (db) {
        expect(db.name).toBe(mongoName);
        await db.dropDatabase();
      }
      await app?.close();
      await userApp?.close();
      if (userDB?.isInitialized) await userDB.destroy();
      await redis.del(['post:events', 'notification:post:dead']);
      await redis.quit();
      await sql.onApplicationShutdown();
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.pool.query(`DROP DATABASE IF EXISTS ${userName}`);
      await admin.onApplicationShutdown();
      vi.unstubAllEnvs();
    }
  },
  60000,
);
