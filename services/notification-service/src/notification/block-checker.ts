import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, sign } from 'node:crypto';

@Injectable()
export class NotificationBlockChecker {
  constructor(private readonly config: ConfigService) {}
  async allowed(recipientId: string, actorId: string): Promise<boolean> {
    if (recipientId === actorId) return false;
    const url =
      this.config.get<string>('blocks.url') ??
      process.env.NOTIFICATION_USER_BLOCKS_URL;
    const raw =
      this.config.get<string>('blocks.privateJwk') ??
      process.env.NOTIFICATION_SERVICE_PRIVATE_JWK;
    // No projection of historical block events is treated as a complete block list.
    if (!url || !raw)
      throw new Error('Authoritative User block check unavailable');
    const endpoint = new URL(url);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error('Invalid User block endpoint');
    const jwk = JSON.parse(raw),
      now = Math.floor(Date.now() / 1000);
    if (
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      jwk.alg !== 'ES256' ||
      !jwk.d ||
      !jwk.kid
    )
      throw new Error('Invalid Notification service key');
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
    const signature = sign('sha256', Buffer.from(`${h}.${p}`), {
      key: createPrivateKey({ key: jwk, format: 'jwk' }),
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h}.${p}.${signature}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ recipientId, actorIds: [actorId] }),
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Authoritative User block check failed');
    const result = (await response.json()) as {
      recipientId?: string;
      recipientActive?: boolean;
      actors?: Array<{ actorId: string; blocked: boolean }>;
    };
    if (
      result.recipientId !== recipientId ||
      typeof result.recipientActive !== 'boolean' ||
      result.actors?.length !== 1 ||
      result.actors[0]?.actorId !== actorId ||
      typeof result.actors[0].blocked !== 'boolean'
    )
      throw new Error('Invalid User block response');
    return result.recipientActive && !result.actors[0].blocked;
  }
}
