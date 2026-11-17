import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrivateKey, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { credentials, loadPackageDefinition, Metadata } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { correlationHeaders } from '../observability/logging.js';

export interface NearbyMapPage {
  users: Array<{ userId: string; revision: string }>;
  nextAfterUserId: string;
}
@Injectable()
export class MapNearbyClient implements OnModuleDestroy {
  private client?: any;
  private nextSync = 0;
  private syncing: Promise<void> | undefined;
  private rpc(method: string, input: unknown, timeout = 5000): Promise<any> {
    if (!this.client) {
      const address = process.env.MAP_GRPC_ADDRESS;
      if (!address || !/^[a-zA-Z0-9.-]+:\d+$/.test(address))
        throw new Error('MAP_GRPC_ADDRESS required for nearby notifications');
      const pkg = loadPackageDefinition(
        loadSync(resolve(process.cwd(), 'contracts/map-notification.proto'), {
          longs: String,
          arrays: true,
          defaults: true,
        }),
      ) as any;
      this.client = new pkg.wgo.map.notifications.v1.MapNotificationRecipients(
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
  async ensureIndex(database: PostgresDatabase) {
    if (this.syncing) return this.syncing;
    if (Date.now() < this.nextSync) return;
    this.syncing = this.reconcile(database).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }
  private async reconcile(database: PostgresDatabase) {
    const started = Date.now();
    // Only explicit, unexpired Notification consent supplies index membership. No coordinates leave Notification.
    const recipients = (
      await database.pool.query<{
        user_id: string;
        revision: string;
        expires_at: Date;
      }>(
        `SELECT user_id,revision,expires_at FROM notification_nearby_subscriptions WHERE expires_at>now()
       AND captured_at>now()-interval '15 minutes' ORDER BY user_id COLLATE "C" LIMIT 10001`,
      )
    ).rows;
    if (recipients.length > 10000)
      throw new Error(
        'Nearby recipient capacity exceeded; fanout retained for retry',
      );
    const snapshot = await this.rpc('beginSnapshot', {
      expectedCount: recipients.length,
    });
    for (let offset = 0; offset < recipients.length; offset += 50) {
      if (Date.now() - started > 20000)
        throw new Error('Nearby reconciliation deadline exceeded');
      await this.rpc('addRecipients', {
        ...snapshot,
        recipients: recipients.slice(offset, offset + 50).map((row) => ({
          userId: row.user_id,
          revision: row.revision,
          expiresAtMs: String(new Date(row.expires_at).getTime()),
        })),
      });
    }
    await this.rpc('publishSnapshot', snapshot);
    this.nextSync = started + 10000;
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
        'findNearbyUsers',
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
            typeof u.revision !== 'string' ||
            !u.revision ||
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
      this.nextSync = 0;
      throw error;
    }
  }
  onModuleDestroy() {
    this.client?.close();
  }
}
