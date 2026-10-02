import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  status,
  type Client,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { LocationAuthorization } from '../application/ports.js';
import {
  LocationDeniedError,
  ParticipationUnavailableError,
} from '../application/errors.js';

type Check = (
  request: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (
    error: ServiceError | null,
    response?: { allowed: boolean; reason: string },
  ) => void,
) => void;
type MapClient = Client & {
  CheckPostCreation: Check;
  CheckPostParticipation: Check;
};

@Injectable()
export class GrpcLocationAuthorization
  implements LocationAuthorization, OnModuleDestroy
{
  private readonly client: MapClient;

  constructor() {
    const definition = loadSync(
      resolve(process.cwd(), 'contracts/map-authorization.proto'),
      { keepCase: false, longs: String },
    );
    const pkg = loadPackageDefinition(definition) as any;
    this.client = new pkg.wgo.map.v1.MapAuthorization(
      process.env.MAP_GRPC_ADDRESS ?? 'localhost:50051',
      credentials.createInsecure(),
    ) as MapClient;
  }

  onModuleDestroy(): void {
    this.client.close();
  }

  assertCanCreate(
    userId: number,
    latitude: number,
    longitude: number,
    radiusM: number,
  ): Promise<void> {
    return this.check('CheckPostCreation', {
      userId: String(userId),
      latitude,
      longitude,
      radiusM,
    });
  }

  assertCanJoin(
    userId: number,
    postId: string,
    latitude: number,
    longitude: number,
    radiusM: number,
  ): Promise<void> {
    return this.check('CheckPostParticipation', {
      userId: String(userId),
      postId,
      latitude,
      longitude,
      radiusM,
    });
  }

  private check(
    method: 'CheckPostCreation' | 'CheckPostParticipation',
    request: object,
  ): Promise<void> {
    let key: ReturnType<typeof createPrivateKey>;
    let kid: string;
    try {
      const jwk = JSON.parse(
        process.env.POST_SERVICE_SIGNING_JWK ?? '',
      ) as Record<string, unknown>;
      if (
        !jwk ||
        jwk.kty !== 'EC' ||
        jwk.crv !== 'P-256' ||
        jwk.alg !== 'ES256' ||
        typeof jwk.kid !== 'string' ||
        !jwk.kid ||
        !['x', 'y', 'd'].every(
          (field) =>
            typeof jwk[field] === 'string' &&
            /^[A-Za-z0-9_-]{43}$/.test(jwk[field] as string) &&
            Buffer.from(jwk[field] as string, 'base64url').toString(
              'base64url',
            ) === jwk[field],
        )
      )
        throw new Error();
      key = createPrivateKey({ key: jwk as any, format: 'jwk' });
      const publicJwk = createPublicKey(key).export({ format: 'jwk' });
      if (publicJwk.x !== jwk.x || publicJwk.y !== jwk.y) throw new Error();
      kid = jwk.kid;
    } catch {
      throw new ParticipationUnavailableError(
        'Map service authentication is not configured',
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'wgo-post-service',
        aud: 'wgo-map-service',
        sub: 'post-service',
        iat: now,
        exp: now + 30,
      }),
    ).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
      key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${header}.${payload}.${signature}`);
    const timeout = Number(process.env.MAP_GRPC_TIMEOUT_MS ?? 500);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000)
      throw new ParticipationUnavailableError('Invalid Map deadline');
    return new Promise((resolve, reject) => {
      this.client[method](
        request,
        metadata,
        { deadline: new Date(Date.now() + timeout) },
        (error, response) => {
          if (error) {
            reject(
              new ParticipationUnavailableError(
                error.code === status.DEADLINE_EXCEEDED
                  ? 'Map authorization timed out'
                  : 'Map authorization unavailable',
              ),
            );
          } else if (!response || typeof response.allowed !== 'boolean') {
            reject(
              new ParticipationUnavailableError(
                'Invalid Map authorization response',
              ),
            );
          } else if (!response.allowed) {
            reject(
              new LocationDeniedError(response.reason || 'Location denied'),
            );
          } else resolve();
        },
      );
    });
  }
}
