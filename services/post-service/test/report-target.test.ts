import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { ReportTargetController } from '../src/post/report-target.controller.js';
import { POST_STATE_QUERIES } from '../src/post/application/ports.js';
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  postId = 'post_11111111-1111-4111-8111-111111111111',
  commentId = 'comment_22222222-2222-4222-8222-222222222222';
const queries = { findPost: vi.fn(), findComment: vi.fn() };
let app: INestApplication;
const url = '/internal/v1/moderation/report-target';
const token = (iss = 'wgo-moderation-service') => {
  const now = Math.floor(Date.now() / 1000),
    h = Buffer.from(
      JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid: 'mod-1' }),
    ).toString('base64url'),
    p = Buffer.from(
      JSON.stringify({
        iss,
        sub: 'moderation-service',
        aud: 'wgo-post-service',
        iat: now,
        exp: now + 30,
      }),
    ).toString('base64url');
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
beforeAll(async () => {
  vi.stubEnv(
    'POST_MODERATION_TRUSTED_JWKS',
    JSON.stringify({
      keys: [
        {
          ...pair.publicKey.export({ format: 'jwk' }),
          iss: 'wgo-moderation-service',
          alg: 'ES256',
          kid: 'mod-1',
        },
      ],
    }),
  );
  const module = await Test.createTestingModule({
    controllers: [ReportTargetController],
    providers: [{ provide: POST_STATE_QUERIES, useValue: queries }],
  }).compile();
  app = module.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});
it('requires Moderation identity even in local mode and never trusts forwarded user identity', async () => {
  await request(app.getHttpServer())
    .post(url)
    .set('x-user-id', '1')
    .send({ targetType: 'POST', postId })
    .expect(401);
  await request(app.getHttpServer())
    .post(url)
    .set('Authorization', `Bearer ${token('wgo-ws-gateway')}`)
    .send({ targetType: 'POST', postId })
    .expect(401);
  expect(queries.findPost).not.toHaveBeenCalled();
});
it('checks Post-owned state and parent identity without disclosing content or author', async () => {
  queries.findPost.mockResolvedValue({ status: 'ACTIVE' });
  queries.findComment.mockResolvedValue({ status: 'ACTIVE' });
  const r = await request(app.getHttpServer())
    .post(url)
    .set('Authorization', `Bearer ${token()}`)
    .send({ targetType: 'COMMENT', postId, commentId })
    .expect(200);
  expect(r.body).toEqual({
    verified: true,
    targetType: 'COMMENT',
    postId,
    commentId,
  });
  expect(queries.findComment).toHaveBeenCalledWith(postId, commentId);
  queries.findComment.mockResolvedValue({ status: 'DELETED' });
  await request(app.getHttpServer())
    .post(url)
    .set('Authorization', `Bearer ${token()}`)
    .send({ targetType: 'COMMENT', postId, commentId })
    .expect(404);
  queries.findPost.mockResolvedValue({ status: 'DELETED' });
  await request(app.getHttpServer())
    .post(url)
    .set('Authorization', `Bearer ${token()}`)
    .send({ targetType: 'POST', postId })
    .expect(404);
});
