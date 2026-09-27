import { createHmac } from 'node:crypto';
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  ServerCredentials,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGrpcServer, createHttpServer } from '../src/server.js';
import type { Location, LocationStore } from '../src/location.js';

const secret = 'map-test-secret-with-at-least-32-characters';
const locations = new Map<number, Location>();
const store: LocationStore = {
  async put(userId, location) {
    locations.set(userId, location);
  },
  async get(userId) {
    return locations.get(userId) ?? null;
  },
};

function token(key = secret): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'wgo-post-service',
      aud: 'wgo-map-service',
      sub: 'post-service',
      iat: now,
      exp: now + 30,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`;
}

describe('Map HTTP and gRPC contract', () => {
  const grpc = createGrpcServer(store);
  const http = createHttpServer(store);
  let client: any;
  let base: string;
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MAP_SERVICE_JWT_SECRET = secret;
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const port = await new Promise<number>((resolve, reject) =>
      grpc.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, bound) => (error ? reject(error) : resolve(bound)),
      ),
    );
    const pkg = loadPackageDefinition(
      loadSync('contracts/map-authorization.proto', { longs: String }),
    ) as any;
    client = new pkg.wgo.map.v1.MapAuthorization(
      `127.0.0.1:${port}`,
      credentials.createInsecure(),
    );
  });
  afterAll(async () => {
    client?.close();
    grpc.forceShutdown();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  const call = (method: string, request: object, jwt = token()) =>
    new Promise<any>((resolve, reject) => {
      const metadata = new Metadata();
      metadata.set('authorization', `Bearer ${jwt}`);
      client[method](
        request,
        metadata,
        { deadline: new Date(Date.now() + 1000) },
        (error: any, response: any) =>
          error ? reject(error) : resolve(response),
      );
    });

  it('updates location and checks creation and participation over gRPC', async () => {
    const update = await fetch(`${base}/api/v1/location`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': '123' },
      body: JSON.stringify({ latitude: 37.5, longitude: 127 }),
    });
    expect(update.status).toBe(200);
    const fields = {
      userId: '123',
      latitude: 37.5,
      longitude: 127,
      radiusM: 250,
    };
    expect((await call('CheckPostCreation', fields)).allowed).toBe(true);
    expect(
      (
        await call('CheckPostParticipation', {
          ...fields,
          postId: `post_${'a'.repeat(36)}`,
        })
      ).allowed,
    ).toBe(true);
    expect(
      (await call('CheckPostCreation', { ...fields, latitude: 38 })).reason,
    ).toBe('OUTSIDE_RADIUS');
    expect(
      (await call('CheckPostCreation', { ...fields, userId: '456' })).reason,
    ).toBe('LOCATION_MISSING');
  });

  it('rejects invalid service JWT', async () => {
    await expect(
      call(
        'CheckPostCreation',
        { userId: '123', latitude: 37.5, longitude: 127, radiusM: 250 },
        token('wrong-secret'),
      ),
    ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
  });

  it('keeps unauthenticated production location updates closed', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const response = await fetch(`${base}/api/v1/location`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-user-id': '123' },
        body: JSON.stringify({ latitude: 37.5, longitude: 127 }),
      });
      expect(response.status).toBe(503);
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
