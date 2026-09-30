import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
  status,
  type GrpcObject,
  type ServiceClientConstructor,
  type ServerUnaryCall,
  type sendUnaryData,
  type Metadata,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { jwtVerify } from 'jose';
import { resolve } from 'node:path';
import { UserQueriesService, UserRpcError } from './user-queries.service.js';

@Injectable()
export class UserGrpcServer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly server = new Server({
    'grpc.max_receive_message_length': 64 * 1024,
  });
  private bound = false;
  port = 0;

  constructor(
    private readonly queries: UserQueriesService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Follow Map's grpc-js/proto-loader convention rather than adding a second transport framework.
    const definition = loadSync(
      resolve(this.config.getOrThrow<string>('grpc.protoPath')),
      { longs: String },
    );
    let pkg = loadPackageDefinition(definition);
    for (const part of this.config
      .getOrThrow<string>('grpc.package')
      .split('.'))
      pkg = pkg[part] as GrpcObject;
    const service = pkg?.UserService as ServiceClientConstructor | undefined;
    if (!service?.service)
      throw new Error('Configured proto/package does not contain UserService');
    this.server.addService(service.service, {
      GetUserProfile: this.handler('GetUserProfile', (input) =>
        this.queries.getUserProfile(input),
      ),
      BatchGetUserProfiles: this.handler('BatchGetUserProfiles', (input) =>
        this.queries.batchGetUserProfiles(input),
      ),
      GetUserStatus: this.handler('GetUserStatus', (input) =>
        this.queries.getUserStatus(input),
      ),
    });
    const address = `${this.config.getOrThrow<string>('grpc.host')}:${this.config.getOrThrow<number>('grpc.port')}`;
    this.port = await new Promise<number>((done, reject) => {
      this.server.bindAsync(
        address,
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : done(port)),
      );
    });
    this.bound = true;
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.bound) {
      this.server.forceShutdown();
      return;
    }
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.server.forceShutdown();
        done();
      }, 2000);
      this.server.tryShutdown(() => {
        clearTimeout(timer);
        done();
      });
    });
    this.bound = false;
  }

  private handler(
    method: 'GetUserProfile' | 'BatchGetUserProfiles' | 'GetUserStatus',
    work: (input: Record<string, unknown>) => Promise<object>,
  ) {
    return async (
      call: ServerUnaryCall<Record<string, unknown>, object>,
      callback: sendUnaryData<object>,
    ) => {
      try {
        const caller = await this.authenticate(call.metadata);
        if (!caller) {
          callback({
            code: status.UNAUTHENTICATED,
            message: 'Invalid service token',
          });
          return;
        }
        if (!this.authorized(caller, method)) {
          callback({
            code: status.PERMISSION_DENIED,
            message: 'Caller is not authorized for this RPC',
          });
          return;
        }
        callback(null, await work(call.request));
      } catch (error) {
        if (error instanceof UserRpcError)
          callback({ code: error.code, message: error.message });
        else
          callback({
            code: status.UNAVAILABLE,
            message: 'User store unavailable',
          });
      }
    };
  }

  private async authenticate(metadata: Metadata): Promise<string | undefined> {
    const secret = this.config.get<string>('grpc.serviceJwtSecret');
    const token = /^Bearer (\S+)$/i.exec(
      String(metadata.get('authorization')[0] ?? ''),
    )?.[1];
    if (!secret || secret.length < 32 || !token) return undefined;
    try {
      // Same short-lived HS256 service JWT convention as Post -> Map, separate from Access JWT.
      const { payload, protectedHeader } = await jwtVerify(
        token,
        new TextEncoder().encode(secret),
        {
          algorithms: ['HS256'],
          audience: 'wgo-user-service',
          requiredClaims: ['sub', 'iss', 'iat', 'exp'],
        },
      );
      const now = Math.floor(Date.now() / 1000);
      const valid =
        protectedHeader.typ === 'JWT' &&
        typeof payload.sub === 'string' &&
        payload.iss === `wgo-${payload.sub}` &&
        typeof payload.iat === 'number' &&
        typeof payload.exp === 'number' &&
        payload.iat <= now + 5 &&
        payload.exp > payload.iat &&
        payload.exp - payload.iat <= 60;
      return valid ? payload.sub : undefined;
    } catch {
      return undefined;
    }
  }

  private authorized(
    caller: string,
    method: 'GetUserProfile' | 'BatchGetUserProfiles' | 'GetUserStatus',
  ): boolean {
    if (caller === 'post-service') return method !== 'GetUserStatus';
    if (caller === 'ws-gateway') return method === 'GetUserStatus';
    return false;
  }
}
