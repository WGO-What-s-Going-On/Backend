import { createHmac, timingSafeEqual } from 'node:crypto';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

export function serviceIdentity(authorization: string | undefined): number | null {
  // 개발용 기본 비밀값은 로컬 연동에만 쓴다. 운영에서는 별도 설정이 없으면 요청을 거부한다.
  const secret = process.env.WS_SERVICE_JWT_SECRET ?? (process.env.NODE_ENV === 'production' ? undefined : 'local-ws-service-secret-change-me-at-least-32');
  if (!secret || secret.length < 32) throw new ServiceUnavailableException('WS service authentication is not configured');
  const token = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) throw new UnauthorizedException('Service token required');
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('Invalid service token');
  const [header = '', payload = '', signature = ''] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { throw new UnauthorizedException('Invalid service token'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException('Invalid service token');
  try {
    // 서명뿐 아니라 발급 주체·대상·수명을 확인해 사용자 토큰과 서비스 토큰을 구분한다.
    const h = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>;
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (h.alg !== 'HS256' || h.typ !== 'JWT' || p.iss !== (process.env.WS_SERVICE_JWT_ISSUER ?? 'wgo-ws-gateway')
      || p.aud !== (process.env.WS_SERVICE_JWT_AUDIENCE ?? 'wgo-post-service') || p.sub !== 'ws-gateway'
      || typeof p.iat !== 'number' || p.iat > now + 5 || typeof p.exp !== 'number' || p.exp <= now || p.exp - p.iat > 60) {
      throw new Error('claims');
    }
    if (p.userId === undefined) return null;
    if (!Number.isSafeInteger(p.userId) || Number(p.userId) <= 0) throw new Error('userId');
    return Number(p.userId);
  } catch { throw new UnauthorizedException('Invalid service token'); }
}

export function internalServiceIdentity(authorization: string | undefined): number | null {
  // 기존 내부 meta/status의 로컬 호출은 유지하되 운영 호출에는 서비스 인증을 강제한다.
  if (process.env.NODE_ENV !== 'production' && !authorization) return null;
  return serviceIdentity(authorization);
}
