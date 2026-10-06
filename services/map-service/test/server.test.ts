import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
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
import { serviceCaller, trustedKeys } from '../src/service-auth.js';

const secret = 'map-test-secret-with-at-least-32-characters';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = pair.publicKey.export({ format: 'jwk' });
const jwk = {
  ...publicJwk,
  iss: 'wgo-post-service',
  alg: 'ES256',
  kid: 'post-1',
};
process.env.MAP_SERVICE_TRUSTED_JWKS = JSON.stringify({ keys: [jwk] });
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

function esToken(
  header: Record<string, unknown> = {},
  claims: Record<string, unknown> = {},
  signer = pair.privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(
    JSON.stringify({
      alg: 'ES256',
      typ: 'wgo-service+jwt',
      kid: 'post-1',
      ...header,
    }),
  ).toString('base64url');
  const encodedPayload = Buffer.from(
    JSON.stringify({
      iss: 'wgo-post-service',
      sub: 'post-service',
      aud: 'wgo-map-service',
      iat: now,
      exp: now + 30,
      ...claims,
    }),
  ).toString('base64url');
  return `${encodedHeader}.${encodedPayload}.${sign('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`), { key: signer, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
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

  const call = (method: string, request: object, jwt = esToken()) =>
    new Promise<any>((resolve, reject) => {
      const metadata = new Metadata();
      if (jwt) metadata.add('authorization', `Bearer ${jwt}`);
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
    expect((await call('CheckPostCreation', fields, token())).allowed).toBe(
      true,
    );
    expect(
      (
        await call('CheckPostParticipation', {
          ...fields,
          postId: `post_${'a'.repeat(36)}`,
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await call(
          'CheckPostParticipation',
          { ...fields, postId: `post_${'a'.repeat(36)}` },
          token(),
        )
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

  it('rejects missing, duplicate, altered, and invalid ES256 tokens for both RPCs', async () => {
    const fields = {
      userId: '123',
      latitude: 37.5,
      longitude: 127,
      radiusM: 250,
      postId: `post_${'a'.repeat(36)}`,
    };
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const now = Math.floor(Date.now() / 1000);
    const invalid = [
      '',
      esToken({}, {}, other.privateKey),
      esToken({ alg: 'none' }),
      esToken({ typ: 'JWT' }),
      esToken({ kid: 'unknown' }),
      esToken({}, { iss: 'wgo-other-service' }),
      esToken({}, { sub: 'other-service' }),
      esToken({}, { aud: 'wgo-other-service' }),
      esToken({}, { exp: now - 1 }),
      esToken({}, { iat: now + 6 }),
      esToken({}, { exp: now + 61 }),
      esToken({}, { exp: now }),
      `${esToken().split('.').slice(0, 2).join('.')}.bad-signature`,
    ];
    for (const method of ['CheckPostCreation', 'CheckPostParticipation']) {
      for (const jwt of invalid)
        await expect(call(method, fields, jwt)).rejects.toMatchObject({
          code: status.UNAUTHENTICATED,
        });
    }
    // grpc-js rejects repeated authorization before dispatching the RPC handler.
    const duplicate = new Metadata();
    duplicate.add('authorization', `Bearer ${esToken()}`);
    duplicate.add('authorization', `Bearer ${esToken()}`);
    expect(serviceCaller(duplicate, trustedKeys())).toBeNull();
    await expect(
      call('CheckPostCreation', fields, `${esToken()},Bearer ${esToken()}`),
    ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
  });

  it('validates JWKS at startup and allows a staged key rotation', async () => {
    expect(() => trustedKeys('{')).toThrow();
    expect(() =>
      trustedKeys(JSON.stringify({ keys: [{ ...jwk, d: 'private' }] })),
    ).toThrow();
    expect(() =>
      trustedKeys(JSON.stringify({ keys: [{ ...jwk, crv: 'P-384' }] })),
    ).toThrow();
    expect(() =>
      trustedKeys(JSON.stringify({ keys: [{ ...jwk, x: 'invalid' }] })),
    ).toThrow();
    expect(() => trustedKeys(JSON.stringify({ keys: [jwk, jwk] }))).toThrow();
    const next = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const nextJwk = {
      ...next.publicKey.export({ format: 'jwk' }),
      iss: 'wgo-post-service',
      alg: 'ES256',
      kid: 'post-2',
    };
    const rotated = trustedKeys(JSON.stringify({ keys: [jwk, nextJwk] }));
    expect(rotated).toHaveLength(2);
    const metadata = new Metadata();
    metadata.set(
      'authorization',
      `Bearer ${esToken({ kid: 'post-2' }, {}, next.privateKey)}`,
    );
    expect(serviceCaller(metadata, rotated)).toBe('post-service');
    expect(
      serviceCaller(metadata, trustedKeys(JSON.stringify({ keys: [jwk] }))),
    ).toBeNull();
    expect(() =>
      trustedKeys(JSON.stringify({ keys: [nextJwk] })),
    ).not.toThrow();
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

describe('MapPostQuery ES256-only contract', () => {
  const nearby = async (query: any) => {
    if (query.latitude === 1) throw new Error('unavailable');
    if (query.cursor && query.cursor !== 'more') throw new InvalidCursorError();
    const items = Array.from({ length: 201 }, (_, i) => ({
      postId: `post_00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      distanceM: i / 2,
    }));
    const remaining =
      query.longitude === 0 ? [] : query.cursor ? items.slice(200) : items;
    return {
      items: remaining.slice(0, query.limit),
      nextCursor: remaining.length > query.limit ? 'more' : null,
    };
  };
  const server = createGrpcServer(store, { nearby });
  let client: any;
  beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    const pkg = loadPackageDefinition(
      loadSync('contracts/map-authorization.proto', { defaults: true }),
    ) as any;
    client = new pkg.wgo.map.v1.MapPostQuery(
      `127.0.0.1:${port}`,
      credentials.createInsecure(),
    );
  });
  afterAll(() => {
    client?.close();
    server.forceShutdown();
  });
  const call = (request: object, jwt = esToken()) =>
    new Promise<any>((resolve, reject) => {
      const metadata = new Metadata();
      metadata.set('authorization', `Bearer ${jwt}`);
      client.SearchNearbyPosts(
        request,
        metadata,
        { deadline: new Date(Date.now() + 1000) },
        (error: any, result: any) => (error ? reject(error) : resolve(result)),
      );
    });
  const query = { latitude: 37.5, longitude: 127, radiusM: 350, limit: 200 };
  it('returns 200 candidates and truncation with an ES256 Post token', async () => {
    const response = await call(query);
    expect(response.items).toHaveLength(200);
    expect(response.truncated).toBe(true);
    expect(response.items[199].distanceM).toBe(99.5);
    expect(response.nextCursor).toBe('more');
  });
  it('passes the existing cursor through gRPC and returns an empty terminal cursor', async () => {
    const first = await call(query);
    const second = await call({ ...query, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].postId).toBe(
      'post_00000000-0000-0000-0000-000000000200',
    );
    expect(second.nextCursor).toBe('');
    expect(second.truncated).toBe(false);
    expect(
      new Set([...first.items, ...second.items].map((p) => p.postId)).size,
    ).toBe(201);
  });
  it('returns empty items and cursor when no nearby posts exist', async () => {
    expect(await call({ ...query, longitude: 0 })).toEqual({
      items: [],
      truncated: false,
      nextCursor: '',
    });
  });
  it.each(['bad', '!', 'a'.repeat(1025)])(
    'rejects invalid cursors',
    async (cursor) => {
      await expect(call({ ...query, cursor })).rejects.toMatchObject({
        code: status.INVALID_ARGUMENT,
      });
    },
  );
  it.each([0, 201, -1])('rejects invalid limit %s', async (limit) => {
    await expect(call({ ...query, limit })).rejects.toMatchObject({
      code: status.INVALID_ARGUMENT,
    });
  });
  it.each([150, 250, 350])('accepts supported radius %s', async (radiusM) => {
    expect((await call({ ...query, radiusM })).items).toHaveLength(200);
  });
  it('rejects invalid coordinates/radius and dependency failures', async () => {
    await expect(call({ ...query, latitude: 91 })).rejects.toMatchObject({
      code: status.INVALID_ARGUMENT,
    });
    await expect(call({ ...query, radiusM: 500 })).rejects.toMatchObject({
      code: status.INVALID_ARGUMENT,
    });
    await expect(call({ ...query, latitude: 1 })).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    });
  });
  it('rejects legacy HS256 and signed tokens with the wrong identity', async () => {
    await expect(call(query, token())).rejects.toMatchObject({
      code: status.UNAUTHENTICATED,
    });
    await expect(
      call(query, esToken({}, { sub: 'http-gateway' })),
    ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
  });
});
