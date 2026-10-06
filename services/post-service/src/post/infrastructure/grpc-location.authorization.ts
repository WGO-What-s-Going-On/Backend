import { mapMetadata, mapDeadline } from './map-service-auth.js';
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
    const metadata = mapMetadata();
    const deadline = mapDeadline();
    return new Promise((resolve, reject) => {
      this.client[method](
        request,
        metadata,
        { deadline },
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
