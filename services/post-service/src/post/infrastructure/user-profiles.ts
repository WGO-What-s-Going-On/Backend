import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Client, credentials, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { resolve } from 'node:path';
import { mapMetadata, mapDeadline } from './map-service-auth.js';
@Injectable()
export class UserProfiles implements OnModuleDestroy {
  private readonly client: Client & { BatchGetUserProfiles: Function };
  constructor() {
    const pkg = loadPackageDefinition(
      loadSync(resolve(process.cwd(), 'contracts/user.proto'), {
        longs: String,
      }),
    ) as any;
    this.client = new pkg.wgo.user.v1.UserService(
      process.env.USER_GRPC_ADDRESS ?? 'localhost:50052',
      credentials.createInsecure(),
    );
  }
  onModuleDestroy() {
    this.client.close();
  }
  async names(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    if (unique.length > 100) throw new Error('Profile batch too large');
    try {
      const result = await new Promise<any>((resolve, reject) =>
        this.client.BatchGetUserProfiles(
          { userIds: unique.map(String) },
          mapMetadata('wgo-user-service'),
          { deadline: mapDeadline() },
          (error: Error | null, response: any) =>
            error ? reject(error) : resolve(response),
        ),
      );
      return new Map(
        (result.profiles ?? []).map((p: any) => [
          Number(p.userId),
          String(p.nickname),
        ]),
      );
    } catch {
      throw new ServiceUnavailableException('Author profiles unavailable');
    }
  }
}
