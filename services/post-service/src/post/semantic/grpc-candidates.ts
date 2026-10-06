import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  Client,
  credentials,
  loadPackageDefinition,
  type Metadata,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { resolve } from 'node:path';
import {
  mapDeadline,
  mapMetadata,
} from '../infrastructure/map-service-auth.js';
import type { NearbyPostCandidates } from './ports.js';
import { CANDIDATE_LIMIT, SCOPE } from './policy.js';

type Response = Awaited<ReturnType<NearbyPostCandidates['search']>>;
@Injectable()
export class GrpcNearbyPosts implements NearbyPostCandidates, OnModuleDestroy {
  private readonly client: Client & {
    SearchNearbyPosts(
      request: object,
      metadata: Metadata,
      options: { deadline: Date },
      callback: (error: ServiceError | null, response: Response) => void,
    ): void;
  };
  constructor() {
    const pkg = loadPackageDefinition(
      loadSync(resolve(process.cwd(), 'contracts/map-authorization.proto'), {
        defaults: true,
      }),
    ) as any;
    this.client = new pkg.wgo.map.v1.MapPostQuery(
      process.env.MAP_GRPC_ADDRESS ?? 'localhost:50051',
      credentials.createInsecure(),
    );
  }
  onModuleDestroy() {
    this.client.close();
  }
  search(latitude: number, longitude: number): Promise<Response> {
    return new Promise((resolve, reject) =>
      this.client.SearchNearbyPosts(
        { latitude, longitude, radiusM: SCOPE.radiusM, limit: CANDIDATE_LIMIT },
        mapMetadata(),
        { deadline: mapDeadline() },
        (error, response) => (error ? reject(error) : resolve(response)),
      ),
    );
  }
}
