import { generateKeyPairSync } from 'node:crypto';
import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GrpcNearbyPosts } from '../src/post/semantic/grpc-candidates.js';

describe('Post nearby gRPC client', () => {
  const server = new Server();
  let client: GrpcNearbyPosts;
  const requests: Array<Record<string, unknown>> = [];
  beforeAll(async () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    vi.stubEnv(
      'POST_SERVICE_SIGNING_JWK',
      JSON.stringify({
        ...pair.privateKey.export({ format: 'jwk' }),
        kid: 'nearby-test',
        alg: 'ES256',
      }),
    );
    const pkg = loadPackageDefinition(
      loadSync('contracts/map-authorization.proto', { defaults: true }),
    ) as any;
    server.addService(pkg.wgo.map.v1.MapPostQuery.service, {
      SearchNearbyPosts: (call: any, callback: any) => {
        requests.push(call.request);
        const items = Array.from(
          { length: call.request.cursor ? 1 : 200 },
          (_, i) => ({
            postId: `post_00000000-0000-0000-0000-${String(i + (call.request.cursor ? 200 : 0)).padStart(12, '0')}`,
            distanceM: i / 2,
          }),
        );
        const truncated = !call.request.cursor;
        callback(null, {
          items,
          truncated,
          ...(call.request.longitude === 0
            ? {}
            : { nextCursor: truncated ? 'next-page' : '' }),
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    vi.stubEnv('MAP_GRPC_ADDRESS', `127.0.0.1:${port}`);
    client = new GrpcNearbyPosts();
  });
  afterAll(() => {
    client?.onModuleDestroy();
    server.forceShutdown();
    vi.unstubAllEnvs();
  });
  it('uses 150m and only the first 200 candidates for similarity even when another page exists', async () => {
    requests.length = 0;
    const result = await client.search(37.5, 127);
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(requests).toEqual([
      { latitude: 37.5, longitude: 127, radiusM: 150, limit: 200, cursor: '' },
    ]);
  });
  it('allows ordinary callers to request subsequent pages with the same gRPC contract', async () => {
    const query = {
      latitude: 37.5,
      longitude: 127,
      radiusM: 150 as const,
      limit: 200,
    };
    const first = await client.page(query);
    const second = await client.page({ ...query, cursor: first.nextCursor! });
    expect(first.nextCursor).toBe('next-page');
    expect(second).toMatchObject({ truncated: false, nextCursor: null });
    expect(second.items).toHaveLength(1);
    expect(requests.at(-1)?.cursor).toBe('next-page');
  });
  it('preserves old-server similarity compatibility but refuses incomplete pagination', async () => {
    expect((await client.search(37.5, 0)).items).toHaveLength(200);
    await expect(
      client.page({ latitude: 37.5, longitude: 0, radiusM: 150, limit: 200 }),
    ).rejects.toThrow('pagination response unavailable');
  });
});
