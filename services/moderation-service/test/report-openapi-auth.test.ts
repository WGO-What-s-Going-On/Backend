import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReportsController } from '../src/reports/reports.controller.js';
import { ReportsService } from '../src/reports/reports.service.js';
import { GatewayAuthGuard } from '../src/reports/gateway-auth.guard.js';
import { configureSwagger } from '../src/swagger.js';
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const result = {
  reportId: 'report_123e4567-e89b-42d3-a456-426614174000',
  status: 'PENDING',
  createdAt: new Date().toISOString(),
  withdrawnAt: null,
};
const reports = {
  create: vi.fn(async () => result),
  withdraw: vi.fn(async () => ({ ...result, status: 'WITHDRAWN' })),
};
async function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'wgo-http-gateway',
    sub: 'http-gateway',
    aud: 'wgo-moderation-service',
    iat: now,
    exp: now + 30,
    ...claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'wgo-service+jwt',
      kid: 'test',
      ...header,
    })
    .sign(privateKey);
}
describe('Report HTTP OpenAPI and Gateway trust boundary', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv(
      'MODERATION_HTTP_GATEWAY_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...publicKey.export({ format: 'jwk' }),
            kid: 'test',
            iss: 'wgo-http-gateway',
            alg: 'ES256',
          },
        ],
      }),
    );
    const module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        GatewayAuthGuard,
        { provide: ReportsService, useValue: reports },
      ],
    }).compile();
    app = module.createNestApplication();
    configureSwagger(app);
    await app.init();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  it('documents both operations, enums, service auth, errors and stable docs paths', async () => {
    await request(app.getHttpServer()).get('/docs').expect(200);
    const { body: doc } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    for (const [path, method, success] of [
      ['/api/v1/moderation/reports', 'post', '201'],
      ['/api/v1/moderation/reports/{reportId}', 'delete', '200'],
    ]) {
      const op = doc.paths[path!][method!];
      expect(op.security).toEqual([{ 'service-jwt': [] }]);
      for (const status of [success, '401', '404', '409', '503'])
        expect(op.responses[status!]).toBeDefined();
      expect(op.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'X-User-Id', required: true }),
        ]),
      );
    }
    expect(
      doc.components.schemas.CreateReportRequest.properties.reason.enum,
    ).toHaveLength(5);
    expect(
      doc.components.schemas.ReportResponse.properties.status.enum,
    ).toEqual(['PENDING', 'WITHDRAWN', 'REVIEWED']);
    expect(
      doc.components.schemas.CreateReportRequest.additionalProperties,
    ).toBe(false);
    expect(doc.components.schemas.CreateReportRequest.oneOf).toHaveLength(2);
    expect(doc.components.securitySchemes['service-jwt'].scheme).toBe('bearer');
  });
  it('rejects identity-only requests in every environment and keeps User tokens separate', async () => {
    for (const path of [
      '/api/v1/moderation/reports',
      `/api/v1/moderation/reports/${result.reportId}`,
    ]) {
      const method = path.endsWith('/reports') ? 'post' : 'delete';
      await request(app.getHttpServer())
        [method](path)
        .set('X-User-Id', '100')
        .send({})
        .expect(401);
    }
    for (const claims of [
      { aud: 'wgo-user-service' },
      { iss: 'other' },
      { sub: 'other' },
      { exp: 1 },
      { iat: Math.floor(Date.now() / 1000) + 60 },
      { exp: Math.floor(Date.now() / 1000) + 120 },
      { aud: ['wgo-moderation-service'] },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/moderation/reports')
        .set('X-User-Id', '100')
        .set('Authorization', `Bearer ${await token(claims)}`)
        .send({})
        .expect(401);
    }
    await request(app.getHttpServer())
      .post('/api/v1/moderation/reports')
      .set('X-User-Id', '100')
      .set('Authorization', `Bearer ${await token({}, { typ: 'JWT' })}`)
      .send({})
      .expect(401);
  });
  it('authenticates both methods and rejects malformed/duplicated user context', async () => {
    const bearer = `Bearer ${await token()}`;
    await request(app.getHttpServer())
      .post('/api/v1/moderation/reports')
      .set('Authorization', bearer)
      .set('X-User-Id', '100')
      .send({})
      .expect(201);
    expect(reports.create).toHaveBeenCalledWith('100', {});
    await request(app.getHttpServer())
      .delete(`/api/v1/moderation/reports/${result.reportId}`)
      .set('Authorization', bearer)
      .set('X-User-Id', '100')
      .expect(200);
    for (const userId of ['01', '0', '9007199254740992', '100, 200'])
      await request(app.getHttpServer())
        .post('/api/v1/moderation/reports')
        .set('Authorization', bearer)
        .set('X-User-Id', userId)
        .send({})
        .expect(401);
  });

  it('rejects unknown signing keys, tampered signatures and duplicated identity headers', async () => {
    const valid = await token();
    const tampered = valid.split('.');
    tampered[2] = `${tampered[2]!.slice(0, -4)}aaaa`;
    for (const value of [
      tampered.join('.'),
      await token({}, { kid: 'unknown' }),
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/moderation/reports')
        .set('Authorization', `Bearer ${value}`)
        .set('X-User-Id', '100')
        .send({})
        .expect(401);
    }
    const guard = new GatewayAuthGuard();
    const req = {
      headers: { authorization: `Bearer ${valid}`, 'x-user-id': '100' },
      rawHeaders: [
        'Authorization',
        `Bearer ${valid}`,
        'X-User-Id',
        '100',
        'X-User-Id',
        '200',
      ],
    };
    await expect(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => req }),
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('missing trusted keys never creates a development auth bypass', async () => {
    vi.stubEnv('MODERATION_HTTP_GATEWAY_TRUSTED_JWKS', '');
    const guard = new GatewayAuthGuard();
    const req = {
      headers: { authorization: `Bearer ${await token()}`, 'x-user-id': '100' },
      rawHeaders: ['Authorization', 'x', 'X-User-Id', '100'],
    };
    await expect(
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => req }),
      } as never),
    ).rejects.toMatchObject({ status: 401 });
  });
});
