import {
  Body,
  Controller,
  Post,
  BadRequestException,
  UnauthorizedException,
  HttpCode,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createPublicKey, verify } from 'node:crypto';
import { parseUserId } from '../user-id.js';

export function notificationServiceIdentity(authorization: unknown): boolean {
  try {
    if (typeof authorization !== 'string') return false;
    const parts = /^Bearer (\S+)$/.exec(authorization)?.[1]?.split('.');
    if (!parts || parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string],
      header = JSON.parse(Buffer.from(h, 'base64url').toString()),
      claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const jwks = JSON.parse(process.env.USER_NOTIFICATION_TRUSTED_JWKS ?? '');
    const matches = jwks.keys?.filter(
      (k: Record<string, unknown>) =>
        k.kid === header.kid && k.iss === 'wgo-notification-service',
    );
    const now = Math.floor(Date.now() / 1000);
    if (
      matches?.length !== 1 ||
      header.alg !== 'ES256' ||
      header.typ !== 'wgo-service+jwt' ||
      !header.kid ||
      matches[0].alg !== 'ES256' ||
      matches[0].kty !== 'EC' ||
      matches[0].crv !== 'P-256' ||
      'd' in matches[0] ||
      claims.iss !== 'wgo-notification-service' ||
      claims.sub !== 'notification-service' ||
      claims.aud !== 'wgo-user-service' ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp) ||
      claims.iat < 0 ||
      claims.iat > now + 5 ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 30 ||
      (claims.nbf !== undefined &&
        (!Number.isInteger(claims.nbf) || claims.nbf > now))
    )
      return false;
    return verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      {
        key: createPublicKey({ key: matches[0], format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(s, 'base64url'),
    );
  } catch {
    return false;
  }
}

@ApiExcludeController()
@Controller('internal/notifications')
export class NotificationBlocksController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}
  @Post('blocks/check')
  @HttpCode(200)
  async check(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Invalid block check');
    const b = body as Record<string, unknown>;
    if (
      Object.keys(b).some((k) => !['recipientId', 'actorIds'].includes(k)) ||
      !parseUserId(b.recipientId) ||
      !Array.isArray(b.actorIds) ||
      b.actorIds.length < 1 ||
      b.actorIds.length > 100 ||
      b.actorIds.some((id) => !parseUserId(id))
    )
      throw new BadRequestException('Invalid block check');
    const [recipient] = await this.db.query(
      'SELECT status FROM users WHERE id=$1',
      [b.recipientId],
    );
    if (!recipient) throw new UnauthorizedException('Recipient unavailable');
    const rows: Array<{ actor_id: string; blocked: boolean }> =
      await this.db.query(
        `SELECT actor.id::text AS actor_id,
      (actor.status<>'ACTIVE' OR EXISTS(SELECT 1 FROM user_blocks b WHERE
        (b.blocker_user_id=$1 AND b.blocked_user_id=actor.id) OR (b.blocker_user_id=actor.id AND b.blocked_user_id=$1))) AS blocked
      FROM users actor WHERE actor.id=ANY($2::bigint[]) ORDER BY actor.id`,
        [b.recipientId, [...new Set(b.actorIds)]],
      );
    if (rows.length !== new Set(b.actorIds).size)
      throw new UnauthorizedException('Actor unavailable');
    return {
      recipientId: b.recipientId,
      recipientActive: recipient.status === 'ACTIVE',
      actors: rows.map((r) => ({ actorId: r.actor_id, blocked: r.blocked })),
    };
  }
}
