import { createPublicKey, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { loadSync } from '@grpc/proto-loader';
import {
  loadPackageDefinition,
  status,
  type Server,
  type Metadata,
} from '@grpc/grpc-js';
import { validCoordinates } from './location.js';
import {
  NotificationRecipientIndex,
  RecipientIndexUnavailable,
} from './notification-recipient-index.js';
import type { LocationGeoIndex } from './location-geo-index.js';
import { observeRpc, rpcContext } from './logging.js';

function notificationKeys(raw = process.env.MAP_NOTIFICATION_TRUSTED_JWKS) {
  try {
    const keys = JSON.parse(raw ?? '').keys as Array<Record<string, any>>;
    if (!keys?.length) throw new Error();
    const parsed = keys.map((jwk) => {
      if (
        jwk.iss !== 'wgo-notification-service' ||
        jwk.kty !== 'EC' ||
        jwk.crv !== 'P-256' ||
        jwk.alg !== 'ES256' ||
        typeof jwk.kid !== 'string' ||
        !jwk.kid ||
        'd' in jwk
      )
        throw new Error();
      return {
        kid: jwk.kid,
        key: createPublicKey({ key: jwk as any, format: 'jwk' }),
      };
    });
    if (new Set(parsed.map((k) => k.kid)).size !== parsed.length)
      throw new Error();
    return parsed;
  } catch {
    throw new Error('Invalid MAP_NOTIFICATION_TRUSTED_JWKS');
  }
}

export function registerNotificationGrpc(
  server: Server,
  index: NotificationRecipientIndex,
  locations?: LocationGeoIndex,
) {
  const keys = notificationKeys();
  const pkg = loadPackageDefinition(
    loadSync(resolve(process.cwd(), 'contracts/map-notification.proto'), {
      longs: String,
    }),
  ) as any;
  function authenticated(metadata: Metadata) {
    try {
      const values = metadata.get('authorization');
      if (values.length !== 1 || typeof values[0] !== 'string') return false;
      const token = /^Bearer (\S+)$/i.exec(values[0])?.[1]?.split('.');
      if (token?.length !== 3) return false;
      const [h, p, s] = token as [string, string, string];
      const header = JSON.parse(Buffer.from(h, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      const key = keys.find((k) => k.kid === header.kid);
      const now = Math.floor(Date.now() / 1000);
      return (
        header.alg === 'ES256' &&
        header.typ === 'wgo-service+jwt' &&
        !!key &&
        claims.iss === 'wgo-notification-service' &&
        claims.sub === 'notification-service' &&
        claims.aud === 'wgo-map-service' &&
        Number.isInteger(claims.iat) &&
        claims.iat <= now + 5 &&
        Number.isInteger(claims.exp) &&
        claims.exp > now &&
        claims.exp > claims.iat &&
        claims.exp - claims.iat <= 60 &&
        Buffer.from(s, 'base64url').length === 64 &&
        verify(
          'sha256',
          Buffer.from(`${h}.${p}`),
          { key: key.key, dsaEncoding: 'ieee-p1363' },
          Buffer.from(s, 'base64url'),
        )
      );
    } catch {
      return false;
    }
  }
  const handler = (
    name: string,
    work: (request: any, check: () => void) => Promise<unknown>,
  ) =>
    rpcContext(async (call: any, callback: any) => {
      callback = observeRpc(call, callback, name);
      if (!authenticated(call.metadata))
        return callback({
          code: status.UNAUTHENTICATED,
          message: 'Notification ES256 token required',
        });
      const check = () => {
        if (call.cancelled || Number(call.getDeadline()) <= Date.now())
          throw new RecipientIndexUnavailable('Request expired');
      };
      try {
        check();
        const result = await work(call.request, check);
        check();
        callback(null, result);
      } catch (error) {
        callback({
          code:
            error instanceof RecipientIndexUnavailable
              ? status.UNAVAILABLE
              : status.INVALID_ARGUMENT,
          message:
            error instanceof RecipientIndexUnavailable
              ? 'Recipient index unavailable; retry'
              : 'Invalid recipient request',
        });
      }
    });
  // Unexpected storage failures must be retried, never reported as invalid input or empty success.
  const storage = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RecipientIndexUnavailable) throw error;
      throw new RecipientIndexUnavailable('Recipient storage failed');
    }
  };
  if (locations) {
    const locationPkg = loadPackageDefinition(
      loadSync(
        resolve(process.cwd(), 'contracts/map-location-recipients.proto'),
        { longs: String },
      ),
    ) as any;
    server.addService(
      locationPkg.wgo.map.locations.v1.MapLocationRecipients.service,
      {
        FindNearbyLocationUsers: handler(
          'FindNearbyLocationUsers',
          async (input, check) => {
            if (
              !validCoordinates(input.latitude, input.longitude) ||
              !Number.isFinite(input.participationRadiusM) ||
              input.participationRadiusM < 1 ||
              input.participationRadiusM > 10000 ||
              !/^[1-9]\d*$/.test(input.authorId) ||
              !Number.isSafeInteger(Number(input.authorId)) ||
              !Number.isInteger(input.limit) ||
              input.limit < 1 ||
              input.limit > 50 ||
              (input.afterUserId &&
                (!/^[1-9]\d*$/.test(input.afterUserId) ||
                  !Number.isSafeInteger(Number(input.afterUserId))))
            )
              throw new Error();
            return storage(() => locations.find(input, check));
          },
        ),
      },
    );
  }
  server.addService(
    pkg.wgo.map.notifications.v1.MapNotificationRecipients.service,
    {
      BeginSnapshot: handler('BeginSnapshot', async (input) => {
        if (
          !Number.isInteger(input.expectedCount) ||
          input.expectedCount < 0 ||
          input.expectedCount > 10000
        )
          throw new Error();
        return {
          snapshotId: await storage(() => index.begin(input.expectedCount)),
        };
      }),
      AddRecipients: handler('AddRecipients', async (input) => {
        if (
          !/^[0-9a-f-]{36}$/.test(input.snapshotId) ||
          !Array.isArray(input.recipients) ||
          input.recipients.length < 1 ||
          input.recipients.length > 50 ||
          input.recipients.some(
            (r: any) =>
              !/^[1-9]\d*$/.test(r.userId) ||
              !Number.isSafeInteger(Number(r.userId)) ||
              typeof r.revision !== 'string' ||
              !r.revision ||
              r.revision.length > 100 ||
              !Number.isSafeInteger(Number(r.expiresAtMs)) ||
              Number(r.expiresAtMs) > Date.now() + 930000,
          )
        )
          throw new Error();
        await storage(() => index.add(input.snapshotId, input.recipients));
        return { snapshotId: input.snapshotId };
      }),
      PublishSnapshot: handler('PublishSnapshot', async (input) => {
        if (!/^[0-9a-f-]{36}$/.test(input.snapshotId)) throw new Error();
        await storage(() => index.publish(input.snapshotId));
        return { snapshotId: input.snapshotId };
      }),
      FindNearbyUsers: handler('FindNearbyUsers', async (input, check) => {
        if (
          !validCoordinates(input.latitude, input.longitude) ||
          !Number.isFinite(input.participationRadiusM) ||
          input.participationRadiusM < 1 ||
          input.participationRadiusM > 10000 ||
          !/^[1-9]\d*$/.test(input.authorId) ||
          !Number.isSafeInteger(Number(input.authorId)) ||
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 50 ||
          (input.afterUserId &&
            (!/^[1-9]\d*$/.test(input.afterUserId) ||
              !Number.isSafeInteger(Number(input.afterUserId))))
        )
          throw new Error();
        return storage(() => index.find(input, check));
      }),
    },
  );
}
