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
import type {
  NearbyPostsPage,
  NearbyPostsQuery,
  NearbyPostsQueryPort,
} from '../application/ports.js';
import { CANDIDATE_LIMIT, SCOPE } from './policy.js';

type Response = Awaited<ReturnType<NearbyPostCandidates['search']>> & {
  nextCursor?: string;
};
@Injectable()
export class GrpcNearbyPosts
  implements NearbyPostCandidates, NearbyPostsQueryPort, OnModuleDestroy
{
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
  async search(latitude: number, longitude: number) {
    // 다음 페이지가 있어도 추천 후보는 요청당 최대 200개로 고정한다.
    const { items, truncated } = await this.request({
      latitude,
      longitude,
      radiusM: SCOPE.radiusM,
      limit: CANDIDATE_LIMIT,
    });
    return { items, truncated };
  }
  async page(query: NearbyPostsQuery): Promise<NearbyPostsPage> {
    const response = await this.request(query);
    const nextCursor = response.nextCursor || null;
    // 구 서버의 truncated만 있는 응답을 마지막 페이지로 오인하지 않는다.
    if (response.truncated !== (nextCursor !== null))
      throw new Error('Map pagination response unavailable');
    return { items: response.items, truncated: response.truncated, nextCursor };
  }
  private request(query: NearbyPostsQuery): Promise<Response> {
    return new Promise((resolve, reject) =>
      this.client.SearchNearbyPosts(
        query,
        mapMetadata(),
        { deadline: mapDeadline() },
        (error, response) => (error ? reject(error) : resolve(response)),
      ),
    );
  }
}
