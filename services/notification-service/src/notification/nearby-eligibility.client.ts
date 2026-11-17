import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign } from 'node:crypto';
import { correlationHeaders, createLogger } from '../observability/logging.js';

@Injectable()
export class NearbyEligibilityClient {
  private readonly logger = createLogger(
    'notification-service',
    'nearby-consent',
  );

  constructor(private readonly config: ConfigService) {}

  private fail(code: string, message: string, statusCode?: number): never {
    this.logger.failure(
      'nearby_eligibility_check_failed',
      undefined,
      code,
      message,
      { targetService: 'user-service', statusCode },
    );
    throw new Error(message);
  }

  async eligible(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const baseUrl =
      this.config.get<string>('blocks.url') ??
      process.env.NOTIFICATION_USER_BLOCKS_URL;
    const url =
      process.env.NOTIFICATION_USER_NEARBY_ELIGIBILITY_URL ??
      (baseUrl &&
        new URL(
          '/internal/notifications/nearby/eligibility',
          baseUrl,
        ).toString());
    const raw = (
      this.config.get<string>('blocks.privateJwk') ??
      process.env.NOTIFICATION_SERVICE_PRIVATE_JWK
    )?.trim();
    // Only the User service owns current term consent and revocation state.
    if (!url)
      this.fail(
        'NEARBY_ELIGIBILITY_URL_MISSING',
        'Authoritative User consent check unavailable',
      );
    if (!raw)
      this.fail(
        'NEARBY_ELIGIBILITY_KEY_MISSING',
        'Authoritative User consent check unavailable',
      );
    if (!URL.canParse(url))
      this.fail(
        'NEARBY_ELIGIBILITY_URL_INVALID',
        'Invalid User consent endpoint',
      );
    const endpoint = new URL(url);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      this.fail(
        'NEARBY_ELIGIBILITY_URL_INVALID',
        'Invalid User consent endpoint',
      );
    const jwk = this.parseKey(raw);
    const now = Math.floor(Date.now() / 1000);
    if (
      jwk?.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      jwk.alg !== 'ES256' ||
      !jwk.d ||
      !jwk.kid
    )
      this.fail(
        'NEARBY_ELIGIBILITY_KEY_INVALID',
        'Invalid Notification service key',
      );
    const h = Buffer.from(
      JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid: jwk.kid }),
    ).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({
        iss: 'wgo-notification-service',
        sub: 'notification-service',
        aud: 'wgo-user-service',
        iat: now,
        exp: now + 30,
      }),
    ).toString('base64url');
    let signature: string;
    try {
      signature = sign('sha256', Buffer.from(`${h}.${p}`), {
        key: createPrivateKey({ key: jwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');
    } catch {
      this.fail(
        'NEARBY_ELIGIBILITY_KEY_INVALID',
        'Invalid Notification service key',
      );
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...correlationHeaders(),
        authorization: `Bearer ${h}.${p}.${signature}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ userIds }),
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    }).catch(() =>
      this.fail(
        'NEARBY_ELIGIBILITY_REQUEST_FAILED',
        'User consent check request failed',
      ),
    );
    if (!response.ok)
      this.fail(
        'NEARBY_ELIGIBILITY_HTTP_ERROR',
        'Authoritative User consent check failed',
        response.status,
      );
    const result = (await response.json().catch(() => null)) as {
      users?: Array<{ userId: string; eligible: boolean }>;
    } | null;
    if (
      !Array.isArray(result?.users) ||
      result.users.length !== userIds.length ||
      new Set(result.users.map((u) => u.userId)).size !== userIds.length ||
      result.users.some(
        (u) => !userIds.includes(u.userId) || typeof u.eligible !== 'boolean',
      )
    )
      this.fail(
        'ELIGIBILITY_RESPONSE_INVALID',
        'Invalid nearby eligibility response',
      );
    return new Set(result.users.filter((u) => u.eligible).map((u) => u.userId));
  }

  private parseKey(raw: string) {
    try {
      return JSON.parse(raw);
    } catch {
      this.fail(
        'NEARBY_ELIGIBILITY_KEY_INVALID',
        'Invalid Notification service key',
      );
    }
  }
}
