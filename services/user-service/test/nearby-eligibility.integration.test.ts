import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { type INestApplication } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { NearbyEligibilityController } from '../src/users/nearby-eligibility.controller.js';
import { configuration } from '../src/config/configuration.js';
import { GatewayAuthGuard } from '../src/http-auth/gateway-auth.guard.js';

describe('Notification nearby consent authority: real PostgreSQL and service authentication', () => {
  let app: INestApplication;
  const gateway = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    notification = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const oldGateway = process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS,
    oldNotification = process.env.USER_NOTIFICATION_TRUSTED_JWKS;
  let db: DataSource, admin: DataSource;
  const name = `wgo_nearby_consent_${process.pid}_${Date.now()}`;
  const token = (
    claims: Record<string, unknown> = {},
    key = notification.privateKey,
  ) =>
    new SignJWT({
      iss: 'wgo-notification-service',
      sub: 'notification-service',
      aud: 'wgo-user-service',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
      ...claims,
    })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'wgo-service+jwt',
        kid: 'notification-1',
      })
      .sign(key);
  beforeAll(async () => {
    process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = JSON.stringify({
      keys: [
        {
          ...gateway.publicKey.export({ format: 'jwk' }),
          alg: 'ES256',
          iss: 'wgo-http-gateway',
          kid: 'gateway-1',
        },
      ],
    });
    process.env.USER_NOTIFICATION_TRUSTED_JWKS = JSON.stringify({
      keys: [
        {
          ...notification.publicKey.export({ format: 'jwk' }),
          alg: 'ES256',
          iss: 'wgo-notification-service',
          kid: 'notification-1',
        },
      ],
    });
    const config = configuration().database;
    if (!['localhost', '127.0.0.1'].includes(config.host))
      throw new Error('Local PostgreSQL required');
    const options = {
      type: 'postgres' as const,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
    };
    admin = await new DataSource({
      ...options,
      database: 'postgres',
    }).initialize();
    await admin.query(`CREATE DATABASE "${name}"`);
    db = await new DataSource({ ...options, database: name }).initialize();
    await db.query(`CREATE TABLE users(id bigint PRIMARY KEY,status text);
      CREATE TABLE terms(id bigint PRIMARY KEY,code text,effective_at timestamptz);
      CREATE TABLE user_term_consents(user_id bigint,term_id bigint,agreed_at timestamptz,revoked_at timestamptz);
      INSERT INTO users VALUES(1,'ACTIVE'),(2,'ACTIVE'),(3,'SUSPENDED'),(4,'ACTIVE'),(5,'ACTIVE');
      INSERT INTO terms VALUES(1,'LOCATION',now()-interval '1 day'),(2,'PRIVACY_COLLECTION_USE',now()-interval '1 day');
      INSERT INTO user_term_consents VALUES(1,1,now(),null),(1,2,now(),null),
        (2,1,now(),now()),(2,2,now(),null),(3,1,now(),null),(3,2,now(),null),
        (5,1,now()+interval '1 day',null),(5,2,now(),null)`);
    const mod = await Test.createTestingModule({
      controllers: [NearbyEligibilityController],
      providers: [
        { provide: DataSource, useValue: db },
        { provide: APP_GUARD, useClass: GatewayAuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.destroy();
    }
    if (oldGateway === undefined)
      delete process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
    else process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = oldGateway;
    if (oldNotification === undefined)
      delete process.env.USER_NOTIFICATION_TRUSTED_JWKS;
    else process.env.USER_NOTIFICATION_TRUSTED_JWKS = oldNotification;
  });
  const endpoint = '/internal/notifications/nearby/eligibility';
  it('requires the distinct Notification service key and rejects forwarded identities', async () => {
    for (const auth of [
      undefined,
      await token({}, gateway.privateKey),
      await token({ aud: 'wrong' }),
      await token({ exp: Math.floor(Date.now() / 1000) - 1 }),
    ]) {
      const req = request(app.getHttpServer())
        .post(endpoint)
        .set('x-wgo-user-id', '1');
      if (auth) req.set('Authorization', `Bearer ${auth}`);
      await req.send({ userIds: ['1'] }).expect(401);
    }
  });
  it('includes only active users with both current unrevoked consents', async () => {
    const response = await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', `Bearer ${await token()}`)
      .send({ userIds: ['1', '2', '3', '4', '5', '999'] })
      .expect(200);
    expect(response.body.users).toEqual([
      { userId: '1', eligible: true },
      { userId: '2', eligible: false },
      { userId: '3', eligible: false },
      { userId: '4', eligible: false },
      { userId: '5', eligible: false },
      { userId: '999', eligible: false },
    ]);
  });
  it('honors revocation and requires the currently effective term rather than historical consent', async () => {
    await db.query(
      'UPDATE user_term_consents SET revoked_at=now() WHERE user_id=1 AND term_id=1',
    );
    let response = await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', `Bearer ${await token()}`)
      .send({ userIds: ['1'] })
      .expect(200);
    expect(response.body.users[0].eligible).toBe(false);
    await db.query(
      "UPDATE user_term_consents SET revoked_at=null WHERE user_id=1; INSERT INTO terms VALUES(3,'LOCATION',now())",
    );
    response = await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', `Bearer ${await token()}`)
      .send({ userIds: ['1'] })
      .expect(200);
    expect(response.body.users[0].eligible).toBe(false);
  });
  it('rejects malformed or duplicate identities', async () => {
    for (const body of [
      { userIds: ['01'] },
      { userIds: [] },
      { userIds: ['1', '1'] },
      { userIds: ['1'], admin: true },
    ])
      await request(app.getHttpServer())
        .post(endpoint)
        .set('Authorization', `Bearer ${await token()}`)
        .send(body)
        .expect(400);
  });
});
