import { describe, expect, it } from 'vitest';

import {
  createRefreshToken,
  hashRefreshToken,
  parseRefreshToken,
  refreshTokenMatchesHash,
} from '../src/auth/refresh-token.js';

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const secret = 'a'.repeat(43);

describe('structured refresh tokens', () => {
  it('encodes a 32-byte URL-safe secret and preserves the session UUID', () => {
    const token = createRefreshToken(sessionId);
    const [prefix, randomSecret] = token.split('.');

    expect(prefix).toBe(sessionId);
    expect(randomSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(randomSecret!, 'base64url')).toHaveLength(32);
    expect(parseRefreshToken(token)).toBe(sessionId);
  });

  it('generates different secrets even for the same session', () => {
    const tokens = Array.from({ length: 20 }, () => createRefreshToken(sessionId));

    expect(new Set(tokens.map((token) => token.slice(token.indexOf('.') + 1))).size).toBe(20);
  });

  it.each([
    '',
    sessionId,
    `.${secret}`,
    `${sessionId}.`,
    `invalid-uuid.${secret}`,
    `550e8400-e29b-41d4-0716-446655440000.${secret}`,
    `${sessionId}.${secret}.extra`,
    `${sessionId}.short`,
    `${sessionId}.${' '.repeat(43)}`,
  ])('returns a validation failure for malformed token %j', (token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });

  it('hashes the entire token, including its session ID', () => {
    const token = createRefreshToken(sessionId);
    const hash = hashRefreshToken(token);
    const changedSession = token.replace(sessionId, '550e8400-e29b-41d4-a716-446655440001');

    expect(refreshTokenMatchesHash(token, hash)).toBe(true);
    expect(refreshTokenMatchesHash(changedSession, hash)).toBe(false);
  });
});

describe('refresh token hashing', () => {
  it('matches the token against its SHA-256 hash', () => {
    const hash = hashRefreshToken('refresh-token');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(refreshTokenMatchesHash('refresh-token', hash)).toBe(true);
    expect(refreshTokenMatchesHash('different-token', hash)).toBe(false);
    expect(refreshTokenMatchesHash('refresh-token', 'invalid')).toBe(false);
  });
});
