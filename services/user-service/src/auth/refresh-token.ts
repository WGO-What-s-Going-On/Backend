import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomBytes(32).toString('base64url')}`;
}

// Parsing identifies a session only; authentication still requires hash verification.
export function parseRefreshToken(refreshToken: string): string | null {
  const separator = refreshToken.indexOf('.');
  if (separator === -1) {
    return null;
  }

  const sessionId = refreshToken.slice(0, separator);
  const secret = refreshToken.slice(separator + 1);
  if (!SESSION_ID_PATTERN.test(sessionId) || !SECRET_PATTERN.test(secret)) {
    return null;
  }

  return sessionId;
}

export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

export function refreshTokenMatchesHash(refreshToken: string, storedHash: string): boolean {
  const actualHash = Buffer.from(hashRefreshToken(refreshToken), 'hex');
  const expectedHash = Buffer.from(storedHash, 'hex');

  return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
}
