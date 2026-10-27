import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { credentials, loadPackageDefinition, status } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { GrpcNearbyPosts } from '../src/post/semantic/grpc-candidates.js';
import { mapMetadata } from '../src/post/infrastructure/map-service-auth.js';
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function slowRequest() {
  return {
    started: gate(),
    cancelled: gate(),
    finished: gate<unknown>(),
    release: gate(),
    reads: [] as string[],
  };
}
const suite = process.env.RUN_WS_INTEGRATION === '1' ? describe : describe.skip;
suite('Post -> real Map search budget transport', () => {
  let server: any, client: GrpcNearbyPosts, raw: any, index: any;
  let mode: 'ok' | 'dense' | 'slow' = 'ok';
  let calls = 0;
  let slow: ReturnType<typeof slowRequest> | undefined;
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
    vi.stubEnv('MAP_GRPC_TIMEOUT_MS', undefined);
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
    index.db.execute = async (sql: string) => {
      calls++;
      const request = slow;
      if (mode === 'slow' && request) {
        request.reads.push(sql);
        request.started.resolve();
        // 후속 조회를 막아 버리면 실제 결함도 timeout으로 숨겨진다. 첫 조회만 보류한다.
        if (request.reads.length === 1) await request.release.promise;
      }
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
      {
        nearby: async (
          input: unknown,
          context: { signal: AbortSignal; deadline: number },
        ) => {
          const request = slow;
          const cancelled = () => request?.cancelled.resolve();
          context.signal.addEventListener('abort', cancelled, { once: true });
          if (context.signal.aborted) cancelled();
          let failure: unknown;
          try {
            return await index.nearby(input, context);
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            context.signal.removeEventListener('abort', cancelled);
            request?.finished.resolve(failure);
          }
        },
      },
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
  afterEach(async () => {
    // 실패한 assertion도 보류된 DB 응답을 해제해 다음 테스트에 요청이 남지 않게 한다.
    slow?.release.resolve();
    if (slow?.reads.length) await slow.finished.promise;
    slow = undefined;
  });
  afterAll(() => {
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
  it('honors the existing default 500ms Post deadline', async () => {
    mode = 'slow';
    slow = slowRequest();
    const start = performance.now();
    await expect(client.search(37.5, 127)).rejects.toMatchObject({
      code: status.DEADLINE_EXCEEDED,
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(1500);
    // 클라이언트 deadline과 서버의 취소 수신은 별개다. 서버 종료 전 DB를 풀지 않는다.
    expect(await slow.finished.promise).toMatchObject({
      code: expect.stringMatching(/^(CANCELLED|DEADLINE_EXCEEDED)$/),
    });
  });
  it('stops later DB reads when the Map search budget expires', async () => {
    mode = 'slow';
    slow = slowRequest();
    // 긴 클라이언트 deadline으로 서버 자체의 1000ms budget 종료를 따로 검증한다.
    const result = new Promise((resolve, reject) => {
      raw.SearchNearbyPosts(
        query,
        mapMetadata(),
        { deadline: Date.now() + 5000 },
        (error: any, value: any) => (error ? reject(error) : resolve(value)),
      );
    });
    await expect(result).rejects.toMatchObject({
      code: status.DEADLINE_EXCEEDED,
    });
    expect(await slow.finished.promise).toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    });
    slow.release.resolve();
    expect(slow.reads).toHaveLength(1);
    expect(slow.reads[0]).toContain('FROM post_locations');
  });
  it('propagates explicit client cancellation and does not start the status read', async () => {
    mode = 'slow';
    slow = slowRequest();
    let handle: any;
    const result = new Promise((resolve, reject) => {
      handle = raw.SearchNearbyPosts(
        query,
        mapMetadata(),
        { deadline: Date.now() + 5000 },
        (error: any, value: any) => (error ? reject(error) : resolve(value)),
      );
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: status.CANCELLED,
    });
    await slow.started.promise;
    handle.cancel();
    await rejected;
    // 서버 AbortSignal을 실제로 관측한 후에만 첫 DB 조회를 완료한다.
    await slow.cancelled.promise;
    slow.release.resolve();
    expect(await slow.finished.promise).toMatchObject({ code: 'CANCELLED' });
    expect(slow.reads).toHaveLength(1);
    expect(slow.reads[0]).toContain('FROM post_locations');
  });
});
