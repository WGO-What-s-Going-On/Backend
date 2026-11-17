import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrivateKey, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { credentials, loadPackageDefinition, Metadata } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { correlationHeaders } from '../observability/logging.js';

export interface NearbyMapPage {
  users: Array<{ userId: string }>;
  nextAfterUserId: string;
}
@Injectable()
export class MapNearbyClient implements OnModuleDestroy {
  private client?: any;
  private rpc(method: string, input: unknown, timeout = 5000): Promise<any> {
    if (!this.client) {
      const address = process.env.MAP_GRPC_ADDRESS;
      if (!address || !/^[a-zA-Z0-9.-]+:\d+$/.test(address))
        throw new Error('MAP_GRPC_ADDRESS required for nearby notifications');
      const pkg = loadPackageDefinition(
        loadSync(
          resolve(process.cwd(), 'contracts/map-location-recipients.proto'),
          {
            longs: String,
            arrays: true,
            defaults: true,
          },
        ),
      ) as any;
      this.client = new pkg.wgo.map.locations.v1.MapLocationRecipients(
        address,
        credentials.createInsecure(),
      );
    }
    const jwk = JSON.parse(process.env.NOTIFICATION_SERVICE_PRIVATE_JWK ?? '');
    if (
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      jwk.alg !== 'ES256' ||
      !jwk.kid ||
      !jwk.d
    )
      throw new Error('Invalid Notification signing key');
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(
      JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid: jwk.kid }),
    ).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({
        iss: 'wgo-notification-service',
        sub: 'notification-service',
        aud: 'wgo-map-service',
        iat: now,
        exp: now + 30,
      }),
    ).toString('base64url');
    const s = sign('sha256', Buffer.from(`${h}.${p}`), {
      key: createPrivateKey({ key: jwk, format: 'jwk' }),
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${h}.${p}.${s}`);
    for (const [key, value] of Object.entries(correlationHeaders()))
      if (value) metadata.set(key, value);
    return new Promise((resolve, reject) =>
      this.client[method](
        input,
        metadata,
        { deadline: Date.now() + timeout },
        (error: unknown, response: unknown) =>
          error ? reject(error) : resolve(response),
      ),
    );
  }
  async find(input: {
    latitude: number;
    longitude: number;
    participationRadiusM: number;
    authorId: string;
    afterUserId: string;
  }): Promise<NearbyMapPage> {
    try {
      const response = await this.rpc(
        'findNearbyLocationUsers',
        { ...input, limit: 50 },
        2000,
      );
      if (
        !Array.isArray(response.users) ||
        response.users.length > 50 ||
        typeof response.nextAfterUserId !== 'string' ||
        response.users.some(
          (u: any, i: number) =>
            !/^[1-9]\d*$/.test(u.userId) ||
            !Number.isSafeInteger(Number(u.userId)) ||
            u.userId <= input.afterUserId ||
            (i > 0 && u.userId <= response.users[i - 1].userId),
        ) ||
        (response.nextAfterUserId &&
          (!/^[1-9]\d*$/.test(response.nextAfterUserId) ||
            !Number.isSafeInteger(Number(response.nextAfterUserId)) ||
            response.nextAfterUserId <= input.afterUserId ||
            response.nextAfterUserId < (response.users.at(-1)?.userId ?? '')))
      )
        throw new Error('Invalid Map recipient page');
      return response;
    } catch (error) {
      throw error;
    }
  }
  onModuleDestroy() {
    this.client?.close();
  }
}
