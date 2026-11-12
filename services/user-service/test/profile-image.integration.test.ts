import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import {
  UserEntity,
  UserStatus,
} from '../src/database/entities/user.entity.js';
import { ProfileImageUploadEntity } from '../src/database/entities/profile-image-upload.entity.js';
import { OutboxEventEntity } from '../src/database/entities/outbox-event.entity.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddPrivateRealName1793200000000 } from '../src/database/migrations/1793200000000-AddPrivateRealName.js';
import { AddProfileImageUploads1793570000000 } from '../src/database/migrations/1793570000000-AddProfileImageUploads.js';
import { GatewayAuthGuard } from '../src/http-auth/gateway-auth.guard.js';
import { UsersController } from '../src/users/users.controller.js';
import { UsersService } from '../src/users/users.service.js';
import { RedisSessionStore } from '../src/auth/redis-session.store.js';
import { ProfileImageService } from '../src/users/profile-image/profile-image.service.js';
import { ProfileImageController } from '../src/users/profile-image/profile-image.controller.js';
import { GcsProfileImageStorage } from '../src/users/profile-image/gcs-profile-image.storage.js';
import { configureSwagger } from '../src/swagger.js';
import { FakeGcs } from './profile-image.fake-gcs.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('base64');
const base = '/api/v1/users/me/profile-image';
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const originalJwks = process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;

describe('Profile images: real PostgreSQL, service JWT, byte-level GCS double', () => {
  const name = `wgo_profile_test_${process.pid}_${Date.now()}`;
  let admin: DataSource;
  let database: DataSource;
  let app: INestApplication;
  let service: ProfileImageService;
  let storage: GcsProfileImageStorage;
  let fake: FakeGcs;
  let token: string;
  let owner: string;
  let other: string;
  beforeAll(async () => {
    const db = configuration().database;
    const connection = {
      type: 'postgres' as const,
      host: db.host,
      port: db.port,
      username: db.username,
      password: db.password,
    };
    admin = await new DataSource({
      ...connection,
      database: 'postgres',
    }).initialize();
    await admin.query(`CREATE DATABASE "${name}"`);
    database = await new DataSource({
      ...connection,
      database: name,
      entities: [...USER_SERVICE_ENTITIES],
      migrations: [
        InitialUserServiceSchema1789990707351,
        AddPrivateRealName1793200000000,
        AddProfileImageUploads1793570000000,
      ],
      synchronize: false,
    }).initialize();
    await database.runMigrations();
    process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = JSON.stringify({
      keys: [
        {
          ...publicKey.export({ format: 'jwk' }),
          alg: 'ES256',
          kid: 'profile-test',
          iss: 'wgo-http-gateway',
        },
      ],
    });
    storage = new GcsProfileImageStorage();
    const module = await Test.createTestingModule({
      controllers: [UsersController, ProfileImageController],
      providers: [
        UsersService,
        ProfileImageService,
        { provide: RedisSessionStore, useValue: {} },
        { provide: GcsProfileImageStorage, useValue: storage },
        { provide: DataSource, useValue: database },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: database.getRepository(UserEntity),
        },
        { provide: APP_GUARD, useClass: GatewayAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    configureSwagger(app);
    await app.listen(0, '127.0.0.1');
    service = module.get(ProfileImageService);
  }, 30000);
  afterAll(async () => {
    await app?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.destroy();
    }
    if (originalJwks === undefined)
      delete process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
    else process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = originalJwks;
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await database.query('TRUNCATE users RESTART IDENTITY CASCADE');
    await database.query('TRUNCATE outbox_events');
    fake = new FakeGcs();
    fake.bind(storage);
    owner = await seed('Owner');
    other = await seed('Other');
    token = await new SignJWT({})
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'wgo-service+jwt',
        kid: 'profile-test',
      })
      .setIssuer('wgo-http-gateway')
      .setSubject('http-gateway')
      .setAudience('wgo-user-service')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(privateKey);
  });
  const auth = (call: request.Test, id?: string) =>
    call.set('Authorization', `Bearer ${token}`).set('X-User-Id', id ?? owner);
  async function seed(nickname: string) {
    const now = new Date();
    const user = await database.getRepository(UserEntity).save({
      nickname,
      status: UserStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
      onboardingCompletedAt: now,
    });
    return user.id;
  }
  async function initiate(bytes = png, contentType = 'image/png') {
    const response = await auth(
      request(app.getHttpServer()).post(`${base}/uploads`),
    )
      .send({ contentType, sizeBytes: bytes.length, checksum: digest(bytes) })
      .expect(201);
    return database
      .getRepository(ProfileImageUploadEntity)
      .findOneByOrFail({ id: response.body.uploadId as string });
  }
  const complete = (id: string, actor?: string) =>
    auth(
      request(app.getHttpServer()).post(`${base}/uploads/${id}/complete`),
      actor,
    );
  const profile = () =>
    database.getRepository(UserEntity).findOneByOrFail({ id: owner });
  const events = () => database.getRepository(OutboxEventEntity).find();

  it.runIf(process.env.RUN_GATEWAY_INTEGRATION === '1')(
    'routes an actual Access JWT through HTTP Gateway to the guarded image APIs',
    async () => {
      const { buildApp } = await import(
        new URL(
          '../../../gateways/http-gateway/dist/src/app.js',
          import.meta.url,
        ).href
      );
      const { loadConfig } = await import(
        new URL(
          '../../../gateways/http-gateway/dist/src/config.js',
          import.meta.url,
        ).href
      );
      const config = loadConfig();
      const secret = 'profile-integration-access-secret-at-least-32-bytes';
      config.rateLimit.enabled = false;
      config.services.user = await app.getUrl();
      config.userAuth = {
        accessSecret: secret,
        issuer: 'profile-test',
        audience: 'wgo-api',
        servicePrivateJwk: JSON.stringify({
          ...privateKey.export({ format: 'jwk' }),
          kid: 'profile-test',
          alg: 'ES256',
        }),
      };
      const gateway = await buildApp({ config, logger: false });
      try {
        const url = await gateway.listen({ host: '127.0.0.1', port: 0 });
        const access = await new SignJWT({ sid: randomUUID() })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setSubject(owner)
          .setIssuer('profile-test')
          .setAudience('wgo-api')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode(secret));
        const headers = {
          Authorization: `Bearer ${access}`,
          'X-User-Id': other,
        };
        await request(url).post(`${base}/uploads`).send({}).expect(401);
        const { body } = await request(url)
          .post(`${base}/uploads`)
          .set(headers)
          .send({
            contentType: 'image/png',
            sizeBytes: png.length,
            checksum: digest(png),
          })
          .expect(201);
        const upload = await database
          .getRepository(ProfileImageUploadEntity)
          .findOneByOrFail({ id: body.uploadId });
        expect(upload.ownerId).toBe(owner);
        fake.put(upload.uploadKey, png);
        await request(url)
          .post(`${base}/uploads/${upload.id}/complete`)
          .set(headers)
          .expect(200);
        await request(url)
          .get(`${base}/url`)
          .set(headers)
          .expect(200)
          .expect(({ body: image }) =>
            expect(image.profileImageKey).toBe(upload.objectKey),
          );
        await request(url)
          .get(`/api/v1/users/${other}/profile-image/url`)
          .set(headers)
          .expect(200);
        await request(url)
          .patch('/api/v1/users/me')
          .set(headers)
          .send({ profileImageKey: other })
          .expect(400);
      } finally {
        await gateway.close();
      }
    },
  );

  it('uploads, applies, reads own/other URL, replaces and removes without replay restoring an old image', async () => {
    const first = await initiate();
    expect(fake.signed[0]).toMatchObject({
      version: 'v4',
      action: 'write',
      extensionHeaders: {
        'content-length': String(png.length),
        'x-goog-if-generation-match': '0',
      },
    });
    expect(first.expiresAt.getTime() - first.createdAt.getTime()).toBe(300000);
    fake.put(first.uploadKey, png);
    await complete(first.id)
      .expect(200)
      .expect(({ body }) => expect(body.isCurrent).toBe(true));
    expect((await profile()).profileImageKey).toBe(first.objectKey);
    expect(await events()).toHaveLength(1);
    await auth(request(app.getHttpServer()).get('/api/v1/users/me'))
      .expect(200)
      .expect(({ body }) => expect(body.profileImageKey).toBe(first.objectKey));
    for (const path of [
      `${base}/url`,
      `/api/v1/users/${owner}/profile-image/url`,
    ])
      await auth(
        request(app.getHttpServer()).get(path),
        path === `${base}/url` ? owner : other,
      )
        .expect(200)
        .expect('Cache-Control', 'no-store');
    expect(fake.signed.at(-1)).toMatchObject({ version: 'v4', action: 'read' });
    const second = await initiate();
    fake.put(second.uploadKey, png);
    await complete(second.id).expect(200);
    await complete(first.id)
      .expect(200)
      .expect(({ body }) => expect(body.isCurrent).toBe(false));
    expect((await profile()).profileImageKey).toBe(second.objectKey);
    await auth(request(app.getHttpServer()).patch('/api/v1/users/me'))
      .send({ profileImageKey: null })
      .expect(200);
    await complete(second.id)
      .expect(200)
      .expect(({ body }) => expect(body.isCurrent).toBe(false));
    await auth(request(app.getHttpServer()).get(`${base}/url`))
      .expect(200)
      .expect({ profileImageKey: null, url: null, expiresAt: null });
    expect(await events()).toHaveLength(3);
  });
  it('rejects missing credentials, external header spoofing, non-owner and unknown upload', async () => {
    const upload = await initiate();
    for (const path of [
      `${base}/uploads`,
      `${base}/uploads/${upload.id}/complete`,
    ])
      await request(app.getHttpServer())
        .post(path)
        .set('X-User-Id', owner)
        .send({})
        .expect(401);
    await request(app.getHttpServer()).get(`${base}/url`).expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/users/${owner}/profile-image/url`)
      .expect(401);
    await complete(upload.id, other).expect(404);
    await complete(randomUUID()).expect(404);
    await complete(upload.id).expect(422);
    expect((await profile()).profileImageKey).toBeNull();
  });
  it.each([
    {},
    { contentType: 'image/gif', sizeBytes: 1, checksum: digest(png) },
    { contentType: 'image/png', sizeBytes: 2097153, checksum: digest(png) },
    { contentType: 'image/png', sizeBytes: 1.5, checksum: digest(png) },
    { contentType: 'image/png', sizeBytes: 1, checksum: 'invalid' },
    {
      contentType: 'image/png',
      sizeBytes: png.length,
      checksum: digest(png),
      objectKey: 'other',
    },
  ])('rejects invalid upload input %j', async (body) => {
    await auth(request(app.getHttpServer()).post(`${base}/uploads`))
      .send(body)
      .expect(400);
  });
  it.each(['size', 'mime', 'checksum', 'magic'] as const)(
    'rejects %s mismatch and preserves legacy image',
    async (kind) => {
      await database
        .getRepository(UserEntity)
        .update(owner, { profileImageKey: 'legacy/image' });
      const bytes = kind === 'magic' ? Buffer.from('not an image at all') : png;
      const upload = await initiate(bytes);
      fake.put(
        upload.uploadKey,
        kind === 'checksum' ? Buffer.alloc(bytes.length) : bytes,
        kind === 'mime' ? 'image/jpeg' : 'image/png',
      );
      if (kind === 'size')
        fake.objects.get(upload.uploadKey)!.declaredSize = bytes.length + 1;
      await complete(upload.id).expect(422);
      expect((await profile()).profileImageKey).toBe('legacy/image');
      expect(fake.objects.has(upload.objectKey)).toBe(false);
      expect(await events()).toHaveLength(0);
    },
  );
  it('rejects expired pending and verified uploads', async () => {
    for (const status of ['PENDING', 'VERIFIED'] as const) {
      const upload = await initiate();
      fake.put(upload.uploadKey, png);
      await database
        .getRepository(ProfileImageUploadEntity)
        .update(upload.id, { status, expiresAt: new Date(0) });
      await complete(upload.id).expect(409);
    }
  });
  it('serializes duplicate and distinct concurrent completion, with one event per upload', async () => {
    const a = await initiate();
    const b = await initiate();
    fake.put(a.uploadKey, png);
    fake.put(b.uploadKey, png);
    await Promise.all([
      complete(a.id).expect(200),
      complete(a.id).expect(200),
      complete(b.id).expect(200),
    ]);
    expect(await events()).toHaveLength(2);
    expect([a.objectKey, b.objectKey]).toContain(
      (await profile()).profileImageKey,
    );
    for (const row of await database
      .getRepository(ProfileImageUploadEntity)
      .find())
      expect(row.status).toBe('APPLIED');
  });
  it('recovers a copy whose response was lost even after the temporary object disappears', async () => {
    const upload = await initiate();
    fake.put(upload.uploadKey, png);
    fake.copyResponseLost = true;
    await complete(upload.id).expect(503);
    expect(fake.objects.has(upload.objectKey)).toBe(true);
    expect((await profile()).profileImageKey).toBeNull();
    fake.objects.delete(upload.uploadKey);
    await complete(upload.id).expect(200);
    expect(await events()).toHaveLength(1);
  });
  it('recovers promotion after the verification transaction rolls back', async () => {
    const upload = await initiate();
    fake.put(upload.uploadKey, png);
    await database.query(`CREATE FUNCTION reject_image_verification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status = 'VERIFIED' THEN RAISE EXCEPTION 'verification commit failure'; END IF; RETURN NEW; END $$`);
    await database.query(
      'CREATE TRIGGER reject_image_verification BEFORE UPDATE ON profile_image_uploads FOR EACH ROW EXECUTE FUNCTION reject_image_verification()',
    );
    try {
      await complete(upload.id).expect(500);
      expect(fake.objects.has(upload.objectKey)).toBe(true);
      expect((await profile()).profileImageKey).toBeNull();
      expect(
        (
          await database
            .getRepository(ProfileImageUploadEntity)
            .findOneByOrFail({ id: upload.id })
        ).status,
      ).toBe('PENDING');
    } finally {
      await database.query(
        'DROP TRIGGER reject_image_verification ON profile_image_uploads',
      );
      await database.query('DROP FUNCTION reject_image_verification()');
    }
    await complete(upload.id).expect(200);
    expect(await events()).toHaveLength(1);
  });
  it('does not restore an image after an applied response is lost or a concurrent removal', async () => {
    const upload = await initiate();
    fake.put(upload.uploadKey, png);
    await service.complete(owner, upload.id); // caller never receives this successful response
    await complete(upload.id).expect(200);
    await Promise.all([
      complete(upload.id).expect(200),
      auth(request(app.getHttpServer()).patch('/api/v1/users/me'))
        .send({ profileImageKey: null })
        .expect(200),
    ]);
    await complete(upload.id)
      .expect(200)
      .expect(({ body }) => expect(body.isCurrent).toBe(false));
    expect((await profile()).profileImageKey).toBeNull();
    expect(await events()).toHaveLength(2);
  });
  it('keeps uploaded images in onboarding without publishing premature USER_CREATED', async () => {
    await database
      .getRepository(UserEntity)
      .update(owner, { onboardingCompletedAt: null });
    const upload = await initiate();
    fake.put(upload.uploadKey, png);
    await complete(upload.id).expect(200);
    expect((await profile()).onboardingCompletedAt).toBeNull();
    expect(await events()).toHaveLength(0);
    await auth(request(app.getHttpServer()).patch('/api/v1/users/me'))
      .send({ nickname: 'Onboarded' })
      .expect(200);
    expect((await events())[0]?.payload.payload).toMatchObject({
      profileImageKey: upload.objectKey,
    });
  });
  it('rolls back profile and Outbox together after promotion, and retries VERIFIED without another copy', async () => {
    const upload = await initiate();
    fake.put(upload.uploadKey, png);
    await database
      .getRepository(UserEntity)
      .update(owner, { profileImageKey: 'legacy/image' });
    const insert = Repository.prototype.insert;
    const spy = vi
      .spyOn(Repository.prototype, 'insert')
      .mockImplementation(function (
        this: Repository<OutboxEventEntity>,
        ...args: Parameters<typeof insert>
      ) {
        if (this.target === OutboxEventEntity)
          return Promise.reject(new Error('injected outbox failure'));
        return insert.apply(this, args);
      });
    await complete(upload.id).expect(500);
    expect((await profile()).profileImageKey).toBe('legacy/image');
    expect(
      (
        await database
          .getRepository(ProfileImageUploadEntity)
          .findOneByOrFail({ id: upload.id })
      ).status,
    ).toBe('VERIFIED');
    expect(await events()).toHaveLength(0);
    spy.mockRestore();
    await complete(upload.id).expect(200);
    await complete(upload.id).expect(200);
    expect(await events()).toHaveLength(1);
  });
  it('handles storage outage without changing profile and retries', async () => {
    const upload = await initiate();
    fake.put(upload.uploadKey, png);
    fake.unavailable = true;
    await complete(upload.id).expect(503);
    expect((await profile()).profileImageKey).toBeNull();
    fake.unavailable = false;
    await complete(upload.id).expect(200);
  });
  it('rejects arbitrary PATCH keys at HTTP and service boundaries', async () => {
    await auth(request(app.getHttpServer()).patch('/api/v1/users/me'))
      .send({ profileImageKey: 'user-profiles/objects/forged' })
      .expect(400);
    await expect(
      new UsersService(
        database.getRepository(UserEntity),
        {} as RedisSessionStore,
      ).updateProfile(owner, { profileImageKey: 'forged' }),
    ).rejects.toThrow('verified');
    expect((await profile()).profileImageKey).toBeNull();
  });
  it('enforces both block directions, target lifecycle and requester status', async () => {
    const users = new UsersService(
      database.getRepository(UserEntity),
      {} as RedisSessionStore,
    );
    for (const [blocker, blocked] of [
      [owner, other],
      [other, owner],
    ]) {
      await users.changeBlock(blocker!, blocked!, true);
      await auth(
        request(app.getHttpServer()).get(
          `/api/v1/users/${other}/profile-image/url`,
        ),
      ).expect(404);
      await users.changeBlock(blocker!, blocked!, false);
    }
    await database
      .getRepository(UserEntity)
      .update(other, { status: UserStatus.WITHDRAWAL_PENDING });
    await auth(
      request(app.getHttpServer()).get(
        `/api/v1/users/${other}/profile-image/url`,
      ),
    ).expect(404);
    await database
      .getRepository(UserEntity)
      .update(owner, { status: UserStatus.SUSPENDED });
    await auth(request(app.getHttpServer()).get(`${base}/url`)).expect(403);
    await auth(request(app.getHttpServer()).post(`${base}/uploads`))
      .send({
        contentType: 'image/png',
        sizeBytes: png.length,
        checksum: digest(png),
      })
      .expect(403);
  });
  it('cleans abandoned/retired uploads, preserves all live references and reconciles late remote writes', async () => {
    const abandoned = await initiate();
    const live = await initiate();
    const postKey = `post-media/objects/media_${live.id}`;
    fake.put(postKey, png);
    fake.put('legacy/image', png);
    fake.put(abandoned.uploadKey, png);
    fake.put(live.uploadKey, png);
    await complete(live.id).expect(200);
    const uploads = database.getRepository(ProfileImageUploadEntity);
    await uploads.update(abandoned.id, {
      expiresAt: new Date(0),
      cleanupAt: new Date(0),
    });
    await uploads.update(live.id, { cleanupAt: new Date(0) });
    await service.cleanup();
    expect(fake.objects.has(abandoned.uploadKey)).toBe(false);
    expect(fake.objects.has(live.objectKey)).toBe(true);
    fake.put(abandoned.objectKey, png); // copy completed after a timeout
    await uploads.update(abandoned.id, {
      cleanupAt: new Date(0),
      retiredAt: new Date(0),
    });
    await service.cleanup();
    expect(fake.objects.has(abandoned.objectKey)).toBe(false);
    // Even a historical shared DB reference must protect a managed final object.
    await database
      .getRepository(UserEntity)
      .update(other, { profileImageKey: live.objectKey });
    await database
      .getRepository(UserEntity)
      .update(owner, { profileImageKey: null });
    await uploads.update(live.id, { cleanupAt: new Date(0) });
    await service.cleanup();
    expect(fake.objects.has(live.objectKey)).toBe(true);
    await database
      .getRepository(UserEntity)
      .update(other, { profileImageKey: null });
    await uploads.update(live.id, { cleanupAt: new Date(0) });
    await service.cleanup();
    expect(fake.objects.has(live.objectKey)).toBe(true); // grace for previously issued GET URLs
    await uploads.update(live.id, {
      cleanupAt: new Date(0),
      retiredAt: new Date(0),
    });
    await service.cleanup();
    expect(fake.objects.has(live.objectKey)).toBe(false);
    expect(fake.objects.get(postKey)?.bytes).toEqual(png);
    expect(fake.objects.get('legacy/image')?.bytes).toEqual(png);
    await complete(live.id)
      .expect(200)
      .expect(({ body }) => expect(body.isCurrent).toBe(false));
  });
  it.each(['uploadKey', 'objectKey'] as const)(
    'refuses a corrupted %s before promotion or cleanup can touch a Post object',
    async (field) => {
      const upload = await initiate();
      const postKey = `post-media/objects/media_${upload.id}`;
      fake.put(postKey, png);
      fake.put(upload.uploadKey, png);
      const uploads = database.getRepository(ProfileImageUploadEntity);
      await uploads.update(upload.id, { [field]: postKey });
      await complete(upload.id).expect(503);
      expect((await profile()).profileImageKey).toBeNull();
      expect(await events()).toHaveLength(0);
      await uploads.update(upload.id, {
        expiresAt: new Date(0),
        cleanupAt: new Date(0),
      });
      await service.cleanup();
      expect(fake.objects.get(postKey)?.bytes).toEqual(png);
      expect(fake.objects.get(upload.uploadKey)?.bytes).toEqual(png);
    },
  );
  it('retains a legacy key on read and never collects its object after replacement/removal', async () => {
    await database
      .getRepository(UserEntity)
      .update(owner, { profileImageKey: 'legacy/image' });
    fake.put('legacy/image', png);
    await auth(request(app.getHttpServer()).get(`${base}/url`))
      .expect(200)
      .expect(({ body }) => expect(body.profileImageKey).toBe('legacy/image'));
    const upload = await initiate();
    fake.put(upload.uploadKey, png);
    await complete(upload.id).expect(200);
    await auth(request(app.getHttpServer()).patch('/api/v1/users/me'))
      .send({ profileImageKey: null })
      .expect(200);
    await database.getRepository(ProfileImageUploadEntity).update(upload.id, {
      cleanupAt: new Date(0),
      retiredAt: new Date(0),
    });
    await service.cleanup();
    expect(fake.objects.get('legacy/image')?.bytes).toEqual(png);
    expect(fake.objects.has(upload.objectKey)).toBe(false);
  });
  it('documents all four image operations and restrictive PATCH contract', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    for (const [path, method] of [
      [`${base}/uploads`, 'post'],
      [`${base}/uploads/{uploadId}/complete`, 'post'],
      [`${base}/url`, 'get'],
      ['/api/v1/users/{userId}/profile-image/url', 'get'],
    ])
      expect(body.paths[path!][method!].security).toEqual([
        { 'service-jwt': [] },
      ]);
    expect(
      body.components.schemas.ProfileImageUploadBody.additionalProperties,
    ).toBe(false);
    expect(
      body.paths['/api/v1/users/me'].patch.requestBody.content[
        'application/json'
      ].schema.properties.profileImageKey.enum,
    ).toEqual([null]);
  });
});
