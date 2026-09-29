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
import { InvalidCursorError } from '../src/post-index.js';
import type { Location, LocationStore } from '../src/location.js';

const secret = 'map-test-secret-with-at-least-32-characters';
const locations = new Map<number, Location>();
const store: LocationStore = {
  async put(userId, location) {
    locations.set(userId, location);
    return location;
  },
  async get(userId) {
    return locations.get(userId) ?? null;
  },
};

function token(key = secret, gateway = false): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: gateway ? 'wgo-http-gateway' : 'wgo-post-service',
      aud: 'wgo-map-service',
      sub: gateway ? 'http-gateway' : 'post-service',
      iat: now,
      exp: now + 30,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`;
}

describe('Map HTTP and gRPC contract', () => {
  const grpc = createGrpcServer(store);
  const http = createHttpServer(store, {
    nearby: async (query) => {
      if (query.cursor) throw new InvalidCursorError();
      if (query.latitude === 1) throw new Error('Cassandra unavailable');
      return {
        items: [
          { postId: 'post_00000000-0000-0000-0000-000000000001', distanceM: 0 },
        ],
        nextCursor: null,
      };
    },
  });
  let client: any;
  let base: string;
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MAP_SERVICE_JWT_SECRET = secret;
    process.env.MAP_GATEWAY_JWT_SECRET = secret;
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

  it('serves Swagger UI and an OpenAPI contract for the HTTP endpoint', async () => {
    const ui = await fetch(`${base}/docs`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('/docs/openapi.json');
    const asset = await fetch(`${base}/docs/swagger-ui-bundle.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    const spec = await fetch(`${base}/docs/openapi.json`);
    expect(spec.status).toBe(200);
    const document = await spec.json();
    expect(document.openapi).toBe('3.0.3');
    expect(Object.keys(document.paths)).toEqual([
      '/api/v1/location',
      '/internal/v1/posts/nearby',
    ]);
    expect(
      Object.keys(document.paths['/api/v1/location'].put.responses),
    ).toEqual(['200', '400', '403', '503']);
  });

  it('requires a gateway JWT and validates nearby parameters', async () => {
    const path = `${base}/internal/v1/posts/nearby?latitude=37.5&longitude=127&radiusM=150`;
    expect((await fetch(path)).status).toBe(401);
    expect(
      (
        await fetch(path, {
          headers: { authorization: `Bearer ${token(secret, true)}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${path}&limit=101`, {
          headers: { authorization: `Bearer ${token(secret, true)}` },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${path}&cursor=bad`, {
          headers: { authorization: `Bearer ${token(secret, true)}` },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(path.replace('latitude=37.5', 'latitude=1'), {
          headers: { authorization: `Bearer ${token(secret, true)}` },
        })
      ).status,
    ).toBe(503);
  });
});
