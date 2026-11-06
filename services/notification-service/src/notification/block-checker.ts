import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign } from 'node:crypto';
import { correlationHeaders, createLogger } from '../observability/logging.js';

@Injectable()
export class NotificationBlockChecker {
  private readonly logger = createLogger('notification-service', 'blocks');

  constructor(private readonly config: ConfigService) {}

  private fail(code: string, message: string, statusCode?: number): never {
    this.logger.failure(
      'notification_block_check_failed',
      undefined,
      code,
      message,
      { targetService: 'user-service', statusCode },
    );
    throw new Error(message);
  }

  async allowed(recipientId: string, actorId: string): Promise<boolean> {
    if (recipientId === actorId) return false;
    const url = (
      this.config.get<string>('blocks.url') ??
      process.env.NOTIFICATION_USER_BLOCKS_URL
    )?.trim();
    const raw = (
      this.config.get<string>('blocks.privateJwk') ??
      process.env.NOTIFICATION_SERVICE_PRIVATE_JWK
    )?.trim();
    // No projection of historical block events is treated as a complete block list.
    if (!url)
      this.fail(
        'BLOCKS_URL_MISSING',
        'Authoritative User block check unavailable',
      );
    if (!raw)
      this.fail(
        'BLOCKS_KEY_MISSING',
        'Authoritative User block check unavailable',
      );
    if (!URL.canParse(url))
      this.fail('BLOCKS_URL_INVALID', 'Invalid User block endpoint');
    const endpoint = new URL(url);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      this.fail('BLOCKS_URL_INVALID', 'Invalid User block endpoint');
    const jwk = this.parseKey(raw);
    const now = Math.floor(Date.now() / 1000);
    if (
      jwk?.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      jwk.alg !== 'ES256' ||
      !jwk.d ||
      !jwk.kid
    )
      this.fail('BLOCKS_KEY_INVALID', 'Invalid Notification service key');
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
      this.fail('BLOCKS_KEY_INVALID', 'Invalid Notification service key');
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...correlationHeaders(),
        authorization: `Bearer ${h}.${p}.${signature}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ recipientId, actorIds: [actorId] }),
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    }).catch(() =>
      this.fail('BLOCKS_REQUEST_FAILED', 'User block check request failed'),
    );
    if (!response.ok)
      this.fail(
        'BLOCKS_HTTP_ERROR',
        'Authoritative User block check failed',
        response.status,
      );
    const result = (await response.json().catch(() => null)) as {
      recipientId?: string;
      recipientActive?: boolean;
      actors?: Array<{ actorId: string; blocked: boolean }>;
    } | null;
    if (
      result?.recipientId !== recipientId ||
      typeof result.recipientActive !== 'boolean' ||
      result.actors?.length !== 1 ||
      result.actors[0]?.actorId !== actorId ||
      typeof result.actors[0].blocked !== 'boolean'
    )
      this.fail('BLOCKS_RESPONSE_INVALID', 'Invalid User block response');
    return result.recipientActive && !result.actors[0].blocked;
  }

  private parseKey(raw: string) {
    try {
      return JSON.parse(raw);
    } catch {
      this.fail('BLOCKS_KEY_INVALID', 'Invalid Notification service key');
    }
  }
}
