import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
  status,
  type Metadata,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { decide, validCoordinates, type LocationStore } from './location.js';
import { serveSwagger } from './swagger.js';

type Check = {
  userId: string;
  postId?: string;
  latitude: number;
  longitude: number;
  radiusM: number;
};
type Decision = { allowed: boolean; reason: string };

export function validServiceToken(
  metadata: Metadata,
  secret = process.env.MAP_SERVICE_JWT_SECRET,
): boolean {
  if (!secret || secret.length < 32) return false;
  const token = /^Bearer (\S+)$/i.exec(
    String(metadata.get('authorization')[0] ?? ''),
  )?.[1];
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) return false;
  try {
    const [header, payload, signature] = parts as [string, string, string];
    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return false;
    const h = JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const p = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    return (
      h.alg === 'HS256' &&
      h.typ === 'JWT' &&
      p.iss === 'wgo-post-service' &&
      p.aud === 'wgo-map-service' &&
      p.sub === 'post-service' &&
      typeof p.iat === 'number' &&
      p.iat <= now + 5 &&
      typeof p.exp === 'number' &&
      p.exp > now &&
      p.exp - p.iat <= 60
    );
  } catch {
    return false;
  }
}

export function createGrpcServer(store: LocationStore): Server {
  const definition = loadSync(
    resolve(process.cwd(), 'contracts/map-authorization.proto'),
    { longs: String },
  );
  const pkg = loadPackageDefinition(definition) as any;
  const server = new Server();
  const check =
    (participation: boolean) =>
    async (
      call: ServerUnaryCall<Check, Decision>,
      callback: sendUnaryData<Decision>,
    ) => {
      if (!validServiceToken(call.metadata))
        return callback({
          code: status.UNAUTHENTICATED,
          message: 'Invalid service token',
        });
      const input = call.request;
      const userId = Number(input.userId);
      if (
        !Number.isSafeInteger(userId) ||
        userId <= 0 ||
        !validCoordinates(input.latitude, input.longitude) ||
        !Number.isFinite(input.radiusM) ||
        input.radiusM < 1 ||
        input.radiusM > 10000 ||
        (participation && !/^post_[0-9a-f-]{36}$/.test(input.postId ?? ''))
      )
        return callback({
          code: status.INVALID_ARGUMENT,
          message: 'Invalid location check',
        });
      try {
        callback(null, decide(await store.get(userId), input, input.radiusM));
      } catch {
        callback({
          code: status.UNAVAILABLE,
          message: 'Location store unavailable',
        });
      }
    };
  server.addService(pkg.wgo.map.v1.MapAuthorization.service, {
    CheckPostCreation: check(false),
    CheckPostParticipation: check(true),
  });
  return server;
}

export async function listenGrpc(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(
      `0.0.0.0:${port}`,
      ServerCredentials.createInsecure(),
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}

export function createHttpServer(store: LocationStore): HttpServer {
  return createServer(async (request, response) => {
    if (await serveSwagger(request, response)) return;
    if (request.method !== 'PUT' || request.url !== '/api/v1/location') {
      response.writeHead(404).end();
      return;
    }
    // 공개 신원 검증은 Gateway 인증이 도입되기 전까지 운영에서 닫아 둔다.
    if (process.env.NODE_ENV === 'production') {
      response.writeHead(503).end();
      return;
    }
    const userId = Number(request.headers['x-user-id']);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      response.writeHead(403).end();
      return;
    }
    let input: Record<string, unknown>;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) throw new Error('body too large');
      }
      input = JSON.parse(body) as Record<string, unknown>;
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !['latitude', 'longitude'].includes(key),
        ) ||
        typeof input.latitude !== 'number' ||
        typeof input.longitude !== 'number' ||
        !validCoordinates(input.latitude, input.longitude)
      )
        throw new Error('invalid coordinates');
    } catch {
      response.writeHead(400).end();
      return;
    }
    const location = {
      latitude: input.latitude as number,
      longitude: input.longitude as number,
      updatedAt: new Date(),
    };
    try {
      await store.put(userId, location);
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(location));
    } catch {
      response.writeHead(503).end();
    }
  });
}
