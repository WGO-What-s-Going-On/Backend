import {
  Injectable,
  ServiceUnavailableException,
  NotFoundException,
} from '@nestjs/common';
import { createPrivateKey, sign } from 'node:crypto';
import type { CreateReportRequest } from './report.dto.js';

@Injectable()
export class ReportTarget {
  async verify(input: CreateReportRequest): Promise<void> {
    const url = process.env.MODERATION_POST_REPORT_TARGET_URL,
      raw = process.env.MODERATION_SERVICE_PRIVATE_JWK;
    if (!url || !raw)
      throw new ServiceUnavailableException(
        'Authenticated Post report-target contract is not configured',
      );
    try {
      const endpoint = new URL(url),
        jwk = JSON.parse(raw);
      if (
        !['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        jwk.kty !== 'EC' ||
        jwk.crv !== 'P-256' ||
        jwk.alg !== 'ES256' ||
        !jwk.d ||
        !jwk.kid
      )
        throw new Error();
      const now = Math.floor(Date.now() / 1000),
        h = Buffer.from(
          JSON.stringify({
            alg: 'ES256',
            typ: 'wgo-service+jwt',
            kid: jwk.kid,
          }),
        ).toString('base64url'),
        p = Buffer.from(
          JSON.stringify({
            iss: 'wgo-moderation-service',
            sub: 'moderation-service',
            aud: 'wgo-post-service',
            iat: now,
            exp: now + 30,
          }),
        ).toString('base64url');
      const s = sign('sha256', Buffer.from(`${h}.${p}`), {
        key: createPrivateKey({ key: jwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h}.${p}.${s}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetType: input.targetType,
          postId: input.postId,
          ...(input.commentId ? { commentId: input.commentId } : {}),
        }),
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      if (response.status === 404)
        throw new NotFoundException('Report target not found');
      if (!response.ok) throw new Error();
      const result = (await response.json()) as Record<string, unknown>;
      if (
        result.verified !== true ||
        result.targetType !== input.targetType ||
        result.postId !== input.postId ||
        result.commentId !== input.commentId
      )
        throw new Error();
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(
        'Authenticated Post report-target verification failed',
      );
    }
  }
}
