import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { credentials, loadPackageDefinition, status } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GrpcNearbyPosts } from '../src/post/semantic/grpc-candidates.js';
import { mapMetadata } from '../src/post/infrastructure/map-service-auth.js';
const suite = process.env.RUN_WS_INTEGRATION === '1' ? describe : describe.skip;
suite('Post -> real Map search budget transport', () => {
  let server: any, client: GrpcNearbyPosts, raw: any, index: any;
  let mode: 'ok' | 'dense' | 'slow' = 'ok';
  let calls = 0;
  const released: Array<() => void> = [];
  beforeAll(async () => {
    const { ServerCredentials } = createRequire(
      new URL('../../map-service/package.json', import.meta.url),
    )('@grpc/grpc-js');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    vi.stubEnv(
      'POST_SERVICE_SIGNING_JWK',
      JSON.stringify({
        ...pair.privateKey.export({ format: 'jwk' }),
        kid: 'budget-test',
        alg: 'ES256',
      }),
    );
    vi.stubEnv(
      'MAP_SERVICE_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...pair.publicKey.export({ format: 'jwk' }),
            kid: 'budget-test',
            alg: 'ES256',
            iss: 'wgo-post-service',
          },
        ],
      }),
    );
    vi.stubEnv('MAP_NEARBY_MAX_CANDIDATES', '2');
    vi.stubEnv('MAP_NEARBY_TIMEOUT_MS', '1000');
    const { PostIndex } = await import(
      new URL(
        '../../../services/map-service/dist/post-index.js',
        import.meta.url,
      ).href
    );
    const { createGrpcServer } = await import(
      new URL('../../../services/map-service/dist/server.js', import.meta.url)
        .href
    );
    index = new PostIndex();
    index.redis.withCommandOptions = () => ({
      eval: async () => [
        1,
        mode === 'dense'
          ? ['a', 'b', 'c']
          : ['post_00000000-0000-4000-8000-000000000001'],
      ],
    });
    index.db.execute = async (_sql: string) => {
      calls++;
      if (mode === 'slow')
        await new Promise<void>((resolve) => released.push(resolve));
      return {
        first: () => ({
          get: (key: string) =>
            (
              ({
                latitude: 37.5,
                longitude: 127,
                status: 'ACTIVE',
                expires_at: null,
              }) as Record<string, unknown>
            )[key],
        }),
      };
    };
    server = createGrpcServer(
      {
        get: async () => null,
        put: async () => {
          throw new Error('unused');
        },
      },
      index,
    );
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error: Error, port: number) => (error ? reject(error) : resolve(port)),
      ),
    );
    vi.stubEnv('MAP_GRPC_ADDRESS', `127.0.0.1:${port}`);
    client = new GrpcNearbyPosts();
    const pkg = loadPackageDefinition(
      loadSync('contracts/map-authorization.proto', { defaults: true }),
    ) as any;
    raw = new pkg.wgo.map.v1.MapPostQuery(
      `127.0.0.1:${port}`,
      credentials.createInsecure(),
    );
  });
  afterAll(() => {
    for (const release of released) release();
    client?.onModuleDestroy();
    raw?.close();
    server?.forceShutdown();
    vi.unstubAllEnvs();
  });
  const query = {
    latitude: 37.5,
    longitude: 127,
    radiusM: 150 as const,
    limit: 200,
  };
  it('preserves successful page and similarity responses', async () => {
    mode = 'ok';
    expect((await client.page(query)).items).toHaveLength(1);
    expect((await client.search(37.5, 127)).items).toHaveLength(1);
  });
  it('propagates RESOURCE_EXHAUSTED instead of returning no similar posts', async () => {
    mode = 'dense';
    calls = 0;
    await expect(client.search(37.5, 127)).rejects.toMatchObject({
      code: status.RESOURCE_EXHAUSTED,
    });
    await expect(client.page(query)).rejects.toMatchObject({
      code: status.RESOURCE_EXHAUSTED,
    });
    expect(calls).toBe(0);
  });
  it('honors the existing default 500ms Post deadline and stops later DB calls', async () => {
    mode = 'slow';
    calls = 0;
    const start = Date.now();
    await expect(client.search(37.5, 127)).rejects.toMatchObject({
      code: status.DEADLINE_EXCEEDED,
    });
    expect(Date.now() - start).toBeLessThan(1500);
    for (const release of released.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
  });
  it('propagates explicit client cancellation and does not start the status read', async () => {
    mode = 'slow';
    calls = 0;
    let handle: any;
    const result = new Promise((resolve, reject) => {
      handle = raw.SearchNearbyPosts(
        query,
        mapMetadata(),
        { deadline: Date.now() + 1000 },
        (error: any, value: any) => (error ? reject(error) : resolve(value)),
      );
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: status.CANCELLED,
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    handle.cancel();
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const release of released.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
  });
});
