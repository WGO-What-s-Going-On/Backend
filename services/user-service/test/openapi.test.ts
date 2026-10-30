import { RewardsController } from '../src/rewards/rewards.controller.js';
import { ActivityService } from '../src/rewards/activity.service.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { UsersController } from '../src/users/users.controller.js';
import { UsersService } from '../src/users/users.service.js';
import { TermsController } from '../src/terms/terms.controller.js';
import { TermsService } from '../src/terms/terms.service.js';
import { HealthController } from '../src/health/health.controller.js';
import { configureSwagger } from '../src/swagger.js';

// Controller-only app exercises the HTTP contract without DB, Redis or Kakao.
describe('User OpenAPI contract', () => {
  let app: INestApplication;
  const auth = {
    loginWithKakao: async () => ({
      userId: '123',
      isNewUser: false,
      onboardingRequired: false,
      restoredFromWithdrawal: false,
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
    }),
    refresh: async () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 900,
    }),
    logout: async () => {},
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [
        AuthController,
        RewardsController,
        UsersController,
        TermsController,
        HealthController,
      ],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: ActivityService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: TermsService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    configureSwagger(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('serves Swagger and documents every implemented HTTP method with accurate status and schemas', async () => {
    await request(app.getHttpServer())
      .get('/docs')
      .expect(200)
      .expect('Content-Type', /html/);
    const { body: doc } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item as object).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
    );
    expect(operations.sort()).toEqual(
      [
        'POST /api/v1/auth/kakao',
        'POST /api/v1/auth/refresh',
        'POST /api/v1/auth/logout',
        'GET /api/v1/users/nickname/availability',
        'GET /api/v1/users/me/blocks',
        'PUT /api/v1/users/me/blocks',
        'DELETE /api/v1/users/me/blocks',
        'GET /api/v1/users/me',
        'PATCH /api/v1/users/me',
        'POST /api/v1/users/me/term-consents',
        'GET /api/v1/users/me/badges',
        'GET /api/v1/users/me/credits',
        'GET /api/v1/users/me/growth',
        'GET /api/v1/users/me/credits/history',
        'GET /api/v1/users/me/badges/history',
        'POST /api/v1/users/me/withdrawal',
        'GET /api/v1/terms',
        'GET /health/live',
      ].sort(),
    );
    expect(
      doc.paths['/api/v1/auth/kakao'].post.responses['201'].content[
        'application/json'
      ].schema.$ref,
    ).toBe('#/components/schemas/KakaoLoginResult');
    expect(
      doc.paths['/api/v1/auth/refresh'].post.responses['200'],
    ).toBeDefined();
    expect(
      doc.paths['/api/v1/auth/logout'].post.responses['204'].content,
    ).toBeUndefined();
    expect(
      doc.paths['/api/v1/auth/logout'].post.parameters.map(
        (p: { name: string }) => p.name,
      ),
    ).toEqual(expect.arrayContaining(['X-User-Id', 'X-Session-Id']));
    expect(doc.paths['/api/v1/users/me'].get.parameters[0]).toMatchObject({
      name: 'X-User-Id',
      required: true,
      schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
    });
    expect(
      doc.paths['/api/v1/users/me'].patch.requestBody.content[
        'application/json'
      ].schema,
    ).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(
      doc.paths['/api/v1/users/me/term-consents'].post.requestBody.content[
        'application/json'
      ].schema.properties.termIds.items.oneOf,
    ).toHaveLength(2);
    expect(
      doc.components.schemas.UserProfileResult.properties.profileImageKey,
    ).toMatchObject({ type: 'string', nullable: true });
    expect(
      doc.components.schemas.NicknameAvailabilityResult.properties.reason.enum,
    ).toEqual(['DUPLICATED']);
    expect(doc.components.securitySchemes['service-jwt']).toMatchObject({
      scheme: 'bearer',
    });
    for (const [path, item] of Object.entries(doc.paths))
      for (const operation of Object.values(
        item as Record<string, { security?: unknown }>,
      ))
        expect(operation.security).toEqual(
          path.startsWith('/api/v1/') ? [{ 'service-jwt': [] }] : undefined,
        );
  });
  it('matches current login/refresh/logout success and input errors, in the isolated controller fixture', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: ' code ' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: 'test' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('X-User-Id', '123')
      .set('X-Session-Id', '123e4567-e89b-12d3-a456-426614174000')
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('X-User-Id', '001')
      .expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(401);
  });
  it('documents reward balances and cursor histories with service authentication', async () => {
    const { body: doc } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    for (const path of [
      'credits',
      'growth',
      'credits/history',
      'badges/history',
    ]) {
      const op = doc.paths[`/api/v1/users/me/${path}`].get;
      expect(
        op.responses['200'].content['application/json'].schema.$ref,
      ).toBeTruthy();
      expect(op.security).toEqual([{ 'service-jwt': [] }]);
    }
  });
  it('exposes confirmed title progress and regional readiness without a new public route', async () => {
    const { body: doc } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    expect(doc.components.schemas.GrowthResult.properties.titles.$ref).toBe(
      '#/components/schemas/TitleProgressResult',
    );
    expect(
      doc.components.schemas.TitleProgressResult.properties
        .highestAchievedStage,
    ).toBeDefined();
    expect(
      doc.components.schemas.RegionalTitleReadinessResult.properties.status
        .enum,
    ).toContain('CONTRACT_UNAVAILABLE');
    expect(
      doc.components.schemas.BadgeHistoryItemResult.properties.regionCode
        .nullable,
    ).toBe(true);
  });
});
