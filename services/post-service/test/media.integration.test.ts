import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { S3MediaStorage } from '../src/post/media/s3-media.storage.js';
import { MediaCleanupWorker } from '../src/post/media/media.worker.js';
import { MediaService } from '../src/post/media/media.service.js';
import type { MediaRecord } from '../src/post/media/media.schema.js';
const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('media HTTP and MongoDB transactions (S3 adapter stubbed)', () => {
  let app: INestApplication;
  let records: Model<MediaRecord>;
  const upload = {
    contentType: 'image/png',
    sizeBytes: 24,
    checksum: Buffer.alloc(32).toString('base64'),
  };
  const draft = {
    title: 'Media post',
    content: 'Details',
    category: 'INCIDENT',
    latitude: 37.5,
    longitude: 127,
    radiusM: 250,
  };
  const s3 = {
    config: {
      enabled: true,
      cleanupMs: 3600000,
      imageBytes: 1024,
      videoBytes: 2048,
    },
    requireEnabled() {},
    upload: vi.fn(async () => ({
      method: 'PUT',
      url: 'https://example.invalid/upload',
      headers: {},
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    })),
    verifyAndPromote: vi.fn(async (_record: MediaRecord) => {}),
    read: vi.fn(async (r: MediaRecord) => ({
      mediaId: r.mediaId,
      type: r.type,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      url: 'https://example.invalid/read',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    })),
    remove: vi.fn(async (_record: MediaRecord) => {}),
  };
  const api = () => request(app.getHttpServer());
  async function ready(owner = '123') {
    const created = await api()
      .post('/api/v1/posts/media/uploads')
      .set('X-User-Id', owner)
      .send(upload)
      .expect(201);
    await api()
      .post(`/api/v1/posts/media/uploads/${created.body.mediaId}/complete`)
      .set('X-User-Id', owner)
      .expect(200);
    return created.body.mediaId as string;
  }
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SEMANTIC_MODEL_ENABLED', 'false');
    vi.stubEnv(
      'MONGODB_URI',
      'mongodb://localhost:27017/wgo_media_integration?replicaSet=rs0',
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOCATION_AUTHORIZATION)
      .useValue({
        assertCanCreate: async () => {},
        assertCanJoin: async () => {},
      })
      .overrideProvider(OutboxWorker)
      .useValue({ wake() {} })
      .overrideProvider(S3MediaStorage)
      .useValue(s3)
      .overrideProvider(UserProfiles)
      .useValue({
        names: async (ids: number[]) =>
          new Map(ids.map((id) => [id, `user-${id}`])),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
    await app.get<Connection>(getConnectionToken()).dropDatabase();
    records = app.get(getModelToken('Media'));
    await records.syncIndexes();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  it('validates upload metadata, owner and production authentication without signing', async () => {
    await api().post('/api/v1/posts/media/uploads').send(upload).expect(403);
    for (const body of [
      { ...upload, sizeBytes: 1025 },
      { ...upload, checksum: 'bad' },
      { ...upload, objectKey: 'forbidden' },
      { ...upload, contentType: 'text/html' },
    ])
      await api()
        .post('/api/v1/posts/media/uploads')
        .set('X-User-Id', '123')
        .send(body)
        .expect(400);
    const id = await ready();
    for (const verb of ['get', 'delete'] as const)
      await api()
        [verb](`/api/v1/posts/media/uploads/${id}`)
        .set('X-User-Id', '456')
        .expect(404);
    await api()
      .post(`/api/v1/posts/media/uploads/${id}/complete`)
      .set('X-User-Id', '456')
      .expect(404);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await api()
        .post('/api/v1/posts/media/uploads')
        .set('X-User-Id', '123')
        .send(upload)
        .expect(401);
      await api()
        .get(`/api/v1/posts/media/uploads/${id}`)
        .set('X-User-Id', '123')
        .expect(401);
      await api()
        .post(`/api/v1/posts/media/uploads/${id}/complete`)
        .set('X-User-Id', '123')
        .expect(401);
      await api()
        .delete(`/api/v1/posts/media/uploads/${id}`)
        .set('X-User-Id', '123')
        .expect(401);
    } finally {
      vi.stubEnv('NODE_ENV', 'test');
    }
  });
  it('atomically attaches five media, refreshes reads and blocks reuse and sixth attachment', async () => {
    const ids = [];
    for (let n = 0; n < 5; n++) ids.push(await ready());
    const sixth = await ready();
    await api()
      .post('/api/v1/posts')
      .set('X-User-Id', '123')
      .send({ ...draft, mediaIds: [...ids, sixth] })
      .expect(400);
    const created = await api()
      .post('/api/v1/posts')
      .set('X-User-Id', '123')
      .send({ ...draft, mediaIds: ids })
      .expect(201);
    const postId = created.body.postId;
    expect(await records.countDocuments({ postId, status: 'ATTACHED' })).toBe(
      5,
    );
    const detail = await api().get(`/api/v1/posts/${postId}`).expect(200);
    expect(detail.body.media.map((m: any) => m.mediaId)).toEqual(ids);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(detail.body)).not.toContain('objectKey');
    await api()
      .get(`/api/v1/posts/${postId}/media`)
      .expect(200)
      .then((r) => expect(r.body).toHaveLength(5));
    await api()
      .post('/api/v1/posts')
      .set('X-User-Id', '123')
      .send({ ...draft, mediaIds: [ids[0]] })
      .expect(409);
    await api()
      .delete(`/api/v1/posts/media/uploads/${ids[0]}`)
      .set('X-User-Id', '123')
      .expect(409);
    await api()
      .post(`/api/v1/posts/${postId}/participants`)
      .set('X-User-Id', '123')
      .send({})
      .expect(201);
    const comment = await api()
      .post(`/api/v1/posts/${postId}/comments`)
      .set('X-User-Id', '123')
      .send({ content: 'Photo', mediaIds: [sixth] })
      .expect(201);
    const cid = comment.body.commentId;
    await api()
      .get(`/api/v1/posts/${postId}/comments/${cid}/media`)
      .expect(200)
      .then((r) => expect(r.body[0].mediaId).toBe(sixth));
    await api()
      .get(`/api/v1/posts/${postId}/comments`)
      .expect(200)
      .then((r) => expect(r.body.comments[0].media[0].mediaId).toBe(sixth));
    await api()
      .delete(`/api/v1/posts/${postId}/comments/${cid}`)
      .set('X-User-Id', '123')
      .expect(204);
    await api()
      .get(`/api/v1/posts/${postId}/comments/${cid}/media`)
      .expect(404);
    await app.get(MediaCleanupWorker).runOnce();
    expect((await records.findOne({ mediaId: sixth }))?.status).toBe(
      'DELETING',
    );
    await api()
      .delete(`/api/v1/posts/${postId}`)
      .set('X-User-Id', '123')
      .expect(204);
    await api().get(`/api/v1/posts/${postId}/media`).expect(404);
  });
  it('rolls back earlier attachment when another owner file fails and allows one concurrent winner', async () => {
    const first = await ready();
    const foreign = await ready('456');
    const posts = app.get<Model<any>>(getModelToken('Post'));
    const count = await posts.countDocuments();
    await api()
      .post('/api/v1/posts')
      .set('X-User-Id', '123')
      .send({ ...draft, mediaIds: [first, foreign] })
      .expect(409);
    expect(await posts.countDocuments()).toBe(count);
    expect((await records.findOne({ mediaId: first }))?.status).toBe('READY');
    const responses = await Promise.all(
      [1, 2].map(() =>
        api()
          .post('/api/v1/posts')
          .set('X-User-Id', '123')
          .send({ ...draft, mediaIds: [first] }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it('rejects pending/expired media and retries cleanup after S3 failure', async () => {
    const pending = await api()
      .post('/api/v1/posts/media/uploads')
      .set('X-User-Id', '123')
      .send(upload)
      .expect(201);
    const id = pending.body.mediaId;
    await api()
      .post('/api/v1/posts')
      .set('X-User-Id', '123')
      .send({ ...draft, mediaIds: [id] })
      .expect(409);
    await records.updateOne(
      { mediaId: id },
      { $set: { expiresAt: new Date(0) } },
    );
    await api()
      .post(`/api/v1/posts/media/uploads/${id}/complete`)
      .set('X-User-Id', '123')
      .expect(409);
    await app.get(MediaCleanupWorker).runOnce();
    expect((await records.findOne({ mediaId: id }))?.status).toBe('DELETING');
    await records.updateOne(
      { mediaId: id },
      { $set: { cleanupAt: new Date(0) } },
    );
    s3.remove.mockRejectedValueOnce(new Error('unavailable'));
    await app.get(MediaCleanupWorker).runOnce();
    expect(await records.exists({ mediaId: id })).not.toBeNull();
    await records.updateOne(
      { mediaId: id },
      { $set: { cleanupAt: new Date(0) } },
    );
    await app.get(MediaCleanupWorker).runOnce();
    expect(await records.exists({ mediaId: id })).toBeNull();
  });
  it('allows either attach or cancellation to win, never both', async () => {
    const id = await ready();
    const [created, cancelled] = await Promise.all([
      api()
        .post('/api/v1/posts')
        .set('X-User-Id', '123')
        .send({ ...draft, mediaIds: [id] }),
      api().delete(`/api/v1/posts/media/uploads/${id}`).set('X-User-Id', '123'),
    ]);
    expect([
      [201, 409],
      [409, 204],
    ]).toContainEqual([created.status, cancelled.status]);
    expect((await records.findOne({ mediaId: id }))?.status).toBe(
      created.status === 201 ? 'ATTACHED' : 'DELETING',
    );
  });
  it('rejects expired READY attachments and rolls back media when outbox insertion fails', async () => {
    const expired = await ready();
    await records.updateOne(
      { mediaId: expired },
      { $set: { expiresAt: new Date(0) } },
    );
    await api()
      .post('/api/v1/posts')
      .set('X-User-Id', '123')
      .send({ ...draft, mediaIds: [expired] })
      .expect(409);
    const id = await ready();
    const outbox = app.get<Model<any>>(getModelToken('Outbox'));
    const failure = vi
      .spyOn(outbox, 'create')
      .mockImplementationOnce(async () => {
        throw new Error('injected outbox failure');
      });
    try {
      await api()
        .post('/api/v1/posts')
        .set('X-User-Id', '123')
        .send({ ...draft, mediaIds: [id] })
        .expect(500);
      expect((await records.findOne({ mediaId: id }))?.status).toBe('READY');
      expect(
        await app
          .get<Model<any>>(getModelToken('Post'))
          .countDocuments({ mediaIds: id }),
      ).toBe(0);
    } finally {
      failure.mockRestore();
    }
  });
  it('does not make a cancelled upload READY when verification finishes late', async () => {
    const service = app.get(MediaService);
    const pending = await service.initiate(123, upload);
    let release!: () => void;
    let entered!: () => void;
    const start = new Promise<void>((resolve) => {
      entered = resolve;
    });
    s3.verifyAndPromote.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const completing = service.complete(123, pending.mediaId);
    await start;
    await service.cancel(123, pending.mediaId);
    release();
    await expect(completing).rejects.toThrow('no longer available');
    expect((await records.findOne({ mediaId: pending.mediaId }))?.status).toBe(
      'DELETING',
    );
  });
});
