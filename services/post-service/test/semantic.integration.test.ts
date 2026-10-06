import type { GrpcNearbyPosts } from '../src/post/semantic/grpc-candidates.js';
import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import type { Connection, Model } from 'mongoose';
import type { Server } from '@grpc/grpc-js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  EMBEDDING_PROVIDER,
  NEARBY_POST_CANDIDATES,
  SEMANTIC_POST_INDEX,
  type EmbeddingProvider,
} from '../src/post/semantic/ports.js';
import { ElasticsearchIndex } from '../src/post/semantic/elasticsearch.js';
import { MongooseSemanticSource } from '../src/post/semantic/mongoose-source.js';
import { IndexSemanticPost } from '../src/post/semantic/index-post.js';
import {
  SemanticConsumer,
  SemanticWorker,
  type StreamEntry,
  withSemanticLease,
} from '../src/post/semantic/worker.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { rebuildSemanticIndex } from '../src/post/semantic/rebuild.js';
import { draft, vector } from './fixtures/semantic.js';
import { E5EmbeddingProvider } from '../src/post/semantic/embedding-provider.js';

// 실제 Map 빌드와 MongoDB/Redis/Cassandra/ES가 필요하다. 대체하는 것은 모델 포트뿐이다.
const suite =
  process.env.RUN_SEMANTIC_INTEGRATION === '1' ? describe : describe.skip;
suite('semantic pipeline with real stores and Map gRPC', () => {
  let app: INestApplication;
  let db: Connection;
  let posts: Model<any>;
  let mapIndex: any;
  let locationStore: any;
  let mapServer: Server;
  let mapConsumer: any;
  let source: MongooseSemanticSource;
  let index: ElasticsearchIndex;
  let consumer: SemanticConsumer;
  const prefix = `semantic-it-${randomUUID()}`;
  const ids: string[] = [];
  const indexes: string[] = [];
  const latitude = 36.173;
  const longitude = 128.533;
  const embedding: EmbeddingProvider = {
    ready: true,
    version: 'v1',
    embed: vi.fn(async (text) => ({
      version: 'v1',
      vector: text.startsWith('other')
        ? [0.8, 0.6, ...Array<number>(382).fill(0)]
        : vector,
    })),
  };
  const signal = () => AbortSignal.timeout(10000);
  const url = (file: string) =>
    pathToFileURL(resolve('../map-service/dist', file)).href;
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'MONGODB_URI',
      `mongodb://localhost:27017/${prefix.replaceAll('-', '_')}?replicaSet=rs0`,
    );
    vi.stubEnv('REDIS_URL', 'redis://localhost:6380/14');
    vi.stubEnv('SEMANTIC_THRESHOLD', '0.7');
    vi.stubEnv('SEMANTIC_WORKER_ENABLED', 'false');
    vi.stubEnv('SEMANTIC_INDEX_ALIAS', `${prefix}-read`);
    vi.stubEnv('MAP_GRPC_TIMEOUT_MS', '10000');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    vi.stubEnv(
      'POST_SERVICE_SIGNING_JWK',
      JSON.stringify({
        ...pair.privateKey.export({ format: 'jwk' }),
        alg: 'ES256',
        kid: 'semantic-test',
      }),
    );
    vi.stubEnv(
      'MAP_SERVICE_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...pair.publicKey.export({ format: 'jwk' }),
            alg: 'ES256',
            kid: 'semantic-test',
            iss: 'wgo-post-service',
          },
        ],
      }),
    );
    const { PostIndex } = await import(url('post-index.js'));
    const { CassandraLocationStore } = await import(url('store.js'));
    const { PostConsumer } = await import(url('post-consumer.js'));
    const { createGrpcServer } = await import(url('server.js'));
    mapIndex = new PostIndex();
    await mapIndex.connect();
    await mapIndex.redis.flushDb(); // 전용 테스트 DB 14만 초기화한다.
    locationStore = new CassandraLocationStore();
    await locationStore.connect();
    await locationStore.put(912341, {
      latitude,
      longitude,
      updatedAt: new Date(),
    });
    mapServer = createGrpcServer(locationStore, mapIndex);
    const { ServerCredentials } = createRequire(
      resolve('../map-service/package.json'),
    )('@grpc/grpc-js') as typeof import('@grpc/grpc-js');
    const port = await new Promise<number>((resolve, reject) =>
      mapServer.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    vi.stubEnv('MAP_GRPC_ADDRESS', `127.0.0.1:${port}`);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(embedding)
      .compile();
    app = module.createNestApplication();
    await app.init();
    db = app.get(getConnectionToken());
    posts = app.get(getModelToken('Post'));
    source = new MongooseSemanticSource(posts);
    index = new ElasticsearchIndex();
    const physical = index.at(`${prefix}-initial`);
    await physical.create();
    indexes.push(physical.target);
    await physical.switchAlias(index.target);
    // client는 환경 설정 이후 만들어진 Map Redis를 사용해 같은 Stream을 읽는다.
    consumer = new SemanticConsumer(
      mapIndex.redis,
      new IndexSemanticPost(source, embedding, index),
    );
    await consumer.initialize();
    mapConsumer = new PostConsumer(mapIndex);
    await mapConsumer.initialize();
  }, 60000);
  afterAll(async () => {
    for (const name of indexes)
      await index?.request('DELETE', name).catch(() => {});
    if (db) await db.dropDatabase();
    await app?.close();
    mapServer?.forceShutdown();
    if (mapIndex) {
      for (const id of ids) {
        const row = (
          await mapIndex.db.execute(
            'SELECT cell, shard FROM post_locations WHERE post_id = ?',
            [id],
            { prepare: true },
          )
        ).first();
        if (row)
          await mapIndex.db.execute(
            'DELETE FROM posts_by_cell WHERE cell = ? AND shard = ? AND post_id = ?',
            [row.get('cell'), row.get('shard'), id],
            { prepare: true },
          );
        await mapIndex.db.execute(
          'DELETE FROM post_locations WHERE post_id = ?',
          [id],
          { prepare: true },
        );
        await mapIndex.db.execute(
          'DELETE FROM post_status WHERE post_id = ?',
          [id],
          { prepare: true },
        );
      }
      await mapIndex.close();
    }
    await locationStore?.close();
    vi.unstubAllEnvs();
  }, 60000);
  const read = async (group: string, name: string) => {
    const batches = await mapIndex.redis.xReadGroup(
      group,
      name,
      { key: 'post:events', id: '>' },
      { COUNT: 250 },
    );
    return (batches ?? []).flatMap(
      (b: { messages: StreamEntry[] }) => b.messages,
    ) as StreamEntry[];
  };
  const similar = (extra = {}) =>
    request(app.getHttpServer())
      .post('/api/v1/posts/similar')
      .set('X-User-Id', '912341')
      .send({ ...draft, latitude, longitude, ...extra });
  it('indexes real creation/outbox events and ranks candidate 200 while excluding candidate 201', async () => {
    for (let i = 0; i < 201; i++) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set('X-User-Id', '912341')
        .send({
          ...draft,
          limit: undefined,
          title: i < 199 ? 'other' : 'best',
          latitude,
          longitude: longitude + i * 0.000005,
        })
        .expect(201);
      ids.push(response.body.postId);
    }
    await expect
      .poll(
        async () => {
          await app.get(OutboxWorker).publishPending();
          return app
            .get<Model<any>>(getModelToken('Outbox'))
            .countDocuments({ status: { $ne: 'PUBLISHED' } });
        },
        { timeout: 10000 },
      )
      .toBe(0);
    const mapEntries = await read('post-map', 'integration-map');
    expect(mapEntries).toHaveLength(201);
    for (const entry of mapEntries) await mapConsumer.process(entry);
    const entries = await read(consumer.group, 'integration-semantic');
    expect(entries).toHaveLength(201);
    for (const entry of entries) await consumer.process(entry);
    await index.refresh();
    const response = await similar({ limit: 1 }).expect(200);
    expect(response.body.items.map((p: any) => p.postId)).toEqual([ids[199]]);
    expect(response.body.partialReasons).toEqual(['CANDIDATE_LIMIT']);
    expect((await similar().expect(200)).body.items).toHaveLength(5);
    expect(
      (await mapIndex.nearby({ latitude, longitude, radiusM: 150, limit: 200 }))
        .items,
    ).toHaveLength(200);
    const mapClient = app.get<GrpcNearbyPosts>(NEARBY_POST_CANDIDATES);
    const query = { latitude, longitude, radiusM: 150 as const, limit: 200 };
    const firstPage = await mapClient.page(query);
    const lastPage = await mapClient.page({
      ...query,
      cursor: firstPage.nextCursor!,
    });
    expect(firstPage.items).toHaveLength(200);
    expect(lastPage.items.map((p) => p.postId)).toEqual([ids[200]]);
    expect(lastPage).toMatchObject({ truncated: false, nextCursor: null });
    expect(
      new Set([...firstPage.items, ...lastPage.items].map((p) => p.postId))
        .size,
    ).toBe(201);
    await expect(
      mapClient.page({
        ...query,
        latitude: latitude + 0.001,
        cursor: firstPage.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 3 });
    await expect(
      mapClient.page({ ...query, radiusM: 250, cursor: firstPage.nextCursor! }),
    ).rejects.toMatchObject({ code: 3 });
    await index.remove(ids[199]!, signal());
    await index.refresh();
    expect((await similar().expect(200)).body.partialReasons).toContain(
      'INDEX_LAG',
    );
    await consumer.indexing.execute(ids[199]!);
    await posts.updateOne(
      { postId: ids[199] },
      { $set: { status: 'DELETED' } },
    );
    await index.refresh();
    expect(
      (await similar().expect(200)).body.items.map((p: any) => p.postId),
    ).not.toContain(ids[199]);
  }, 120000);
  it('recovers a pending delivery through XAUTOCLAIM and reuses saved vectors', async () => {
    const eventId = `evt_${randomUUID()}`;
    const envelope = {
      eventId,
      eventType: 'PostCreated',
      producer: 'post-service',
      schemaVersion: 1,
      aggregateId: ids[0],
      post: { postId: ids[0] },
      occurredAt: new Date().toISOString(),
    };
    await mapIndex.redis.xAdd('post:events', '*', {
      eventId,
      eventType: 'PostCreated',
      data: JSON.stringify(envelope),
    });
    const entry = (await read(consumer.group, 'crashed'))[0]!;
    await consumer.indexing.execute(ids[0]!);
    vi.mocked(embedding.embed).mockClear();
    await mapIndex.redis.xClaim(
      'post:events',
      consumer.group,
      'crashed',
      0,
      entry.id,
      { IDLE: 31000 },
    );
    await consumer.tick();
    expect(
      (await mapIndex.redis.xPending('post:events', consumer.group)).pending,
    ).toBe(0);
    expect(embedding.embed).not.toHaveBeenCalled();
  });
  it('rebuilds old source outside Stream retention, catches up, switches alias and serializes with worker', async () => {
    const old = await posts.findOne({ postId: ids[0] }).lean();
    const oldId = `post_${randomUUID()}`;
    const { _id: _, ...fields } = old;
    await posts.create({ ...fields, postId: oldId, createdAt: new Date(0) });
    // lease 보유 중에는 Worker가 배달을 시작하지 않는다.
    await withSemanticLease(mapIndex.redis, 'v1', async () => {
      expect(
        await withSemanticLease(mapIndex.redis, 'v1', async () => {}),
      ).toBeNull();
    });
    const originalScan = source.scan.bind(source);
    let updated = false;
    source.scan = async function* () {
      yield* originalScan();
      if (!updated) {
        updated = true;
        await posts.updateOne(
          { postId: ids[0] },
          { $set: { content: 'catch-up content', updatedAt: new Date() } },
        );
        const eventId = `evt_${randomUUID()}`;
        await mapIndex.redis.xAdd('post:events', '*', {
          eventId,
          eventType: 'PostCreated',
          data: JSON.stringify({
            eventId,
            eventType: 'PostCreated',
            schemaVersion: 1,
            producer: 'post-service',
            aggregateId: ids[0],
            post: { postId: ids[0] },
            occurredAt: new Date().toISOString(),
          }),
        });
      }
    };
    const result = await rebuildSemanticIndex(
      source,
      embedding,
      index,
      mapIndex.redis,
    );
    indexes.push(result.index);
    expect(result.verified).toBe(201);
    expect(await index.get(oldId, signal())).not.toBeNull();
    expect(await index.get(ids[199]!, signal())).toBeNull();
    expect(
      Object.keys(
        await index.request<Record<string, unknown>>(
          'GET',
          `_alias/${index.target}`,
        ),
      ),
    ).toEqual([result.index]);
  }, 120000);
  it('runs the Nest worker with an injected model and restores a missing document', async () => {
    await index.remove(ids[3]!, signal());
    const eventId = `evt_${randomUUID()}`;
    await mapIndex.redis.xAdd('post:events', '*', {
      eventId,
      eventType: 'PostCreated',
      data: JSON.stringify({
        eventId,
        eventType: 'PostCreated',
        schemaVersion: 1,
        producer: 'post-service',
        aggregateId: ids[3],
        post: { postId: ids[3] },
        occurredAt: new Date().toISOString(),
      }),
    });
    vi.stubEnv('SEMANTIC_WORKER_ENABLED', 'true');
    const worker = app.get(SemanticWorker);
    worker.onModuleInit();
    try {
      await expect
        .poll(() => index.get(ids[3]!, signal()), { timeout: 10000 })
        .not.toBeNull();
    } finally {
      await worker.onModuleDestroy();
      vi.stubEnv('SEMANTIC_WORKER_ENABLED', 'false');
    }
  });

  it('does not auto-create a wrongly mapped index when the alias is missing', async () => {
    const document = await index.get(ids[0]!, signal());
    const missing = new ElasticsearchIndex(`${prefix}-missing`);
    await expect(missing.put(document!, signal())).rejects.toThrow(
      'Elasticsearch 404',
    );
    expect(
      await missing.request('GET', missing.target, undefined, undefined, true),
    ).toBeNull();
  });

  it('keeps the alias unchanged when stream retention crosses the rebuild watermark', async () => {
    const before = await index.request<Record<string, unknown>>(
      'GET',
      `_alias/${index.target}`,
    );
    const record = (await source.batch([ids[0]!]))[0]!;
    let trimmed = false;
    const shortSource = {
      batch: source.batch.bind(source),
      async *scan() {
        yield record;
        if (!trimmed) {
          trimmed = true;
          const eventId = `evt_${randomUUID()}`;
          await mapIndex.redis.xAdd('post:events', '*', {
            eventId,
            eventType: 'PostCreated',
            data: JSON.stringify({
              eventId,
              eventType: 'PostCreated',
              schemaVersion: 1,
              producer: 'post-service',
              aggregateId: record.postId,
              post: { postId: record.postId },
              occurredAt: new Date().toISOString(),
            }),
          });
          await mapIndex.redis.xTrim('post:events', 'MAXLEN', 0);
        }
      },
    };
    try {
      await expect(
        rebuildSemanticIndex(shortSource, embedding, index, mapIndex.redis),
      ).rejects.toThrow('retention');
      expect(await index.request('GET', `_alias/${index.target}`)).toEqual(
        before,
      );
    } finally {
      const state = await mapIndex.redis.hGetAll('post-semantic-v1:rebuild');
      if (state.index) indexes.push(state.index);
    }
  });
  it.runIf(process.env.RUN_EMBEDDING_MODEL === '1')(
    'rebuilds with real E5 vectors and serves the HTTP API through real Map gRPC',
    async () => {
      const real = new E5EmbeddingProvider();
      const realIndex = new ElasticsearchIndex(`${prefix}-e5-read`);
      let realApp: INestApplication | undefined;
      try {
        await real.initialize();
        const rebuilt = await rebuildSemanticIndex(
          source,
          real,
          realIndex,
          mapIndex.redis,
        );
        indexes.push(rebuilt.index);
        expect(rebuilt.verified).toBeGreaterThan(0);
        const document = await realIndex.get(ids[0]!, signal());
        expect(document!.embeddingVersion).toBe(real.version);
        expect(document!.embedding).toHaveLength(384);

        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(EMBEDDING_PROVIDER)
          .useValue(real)
          .overrideProvider(SEMANTIC_POST_INDEX)
          .useValue(realIndex)
          .compile();
        realApp = module.createNestApplication();
        await realApp.init();
        const record = (await source.batch([ids[0]!]))[0]!;
        const response = await request(realApp.getHttpServer())
          .post('/api/v1/posts/similar')
          .set('X-User-Id', '912341')
          .send({
            ...draft,
            latitude,
            longitude,
            title: record.title,
            content: record.content,
            limit: 1,
          })
          .expect(200);
        expect(response.body.items).toHaveLength(1);
        expect(response.body.items[0].title).toBe(record.title);
        expect(response.body.scope.radiusM).toBe(150);

        // 실제 모델의 준비가 끝난 후 새 버전의 Worker가 누락 문서를 복구한다.
        await realIndex.remove(ids[0]!, signal());
        const eventId = `evt_${randomUUID()}`;
        await mapIndex.redis.xAdd('post:events', '*', {
          eventId,
          eventType: 'PostCreated',
          data: JSON.stringify({
            eventId,
            eventType: 'PostCreated',
            schemaVersion: 1,
            producer: 'post-service',
            aggregateId: ids[0],
            post: { postId: ids[0] },
            occurredAt: new Date().toISOString(),
          }),
        });
        vi.stubEnv('SEMANTIC_WORKER_ENABLED', 'true');
        const worker = realApp.get(SemanticWorker);
        worker.onModuleInit();
        await expect
          .poll(() => realIndex.get(ids[0]!, signal()), { timeout: 10000 })
          .not.toBeNull();
        await worker.onModuleDestroy();
      } finally {
        vi.stubEnv('SEMANTIC_WORKER_ENABLED', 'false');
        await realApp?.close();
        await real.close();
      }
    },
    120000,
  );
});
