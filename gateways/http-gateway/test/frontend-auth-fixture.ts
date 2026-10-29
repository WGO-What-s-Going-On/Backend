import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { UserAuthConfig } from '../src/user-auth.js';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
export const frontendAuth: UserAuthConfig = {
  accessSecret: 'frontend-test-access-secret-longer-than-32',
  issuer: 'wgo-user',
  audience: 'wgo-api',
  servicePrivateJwk: JSON.stringify({
    ...pair.privateKey.export({ format: 'jwk' }),
    alg: 'ES256',
    kid: 'frontend-test',
  }),
};
export function frontendBearer() {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const p = Buffer.from(
    JSON.stringify({
      sub: '123',
      sid: '5e614031-b7fb-47bf-9d0d-23434eb18acd',
      iss: frontendAuth.issuer,
      aud: frontendAuth.audience,
      iat: now,
      exp: now + 300,
    }),
  ).toString('base64url');
  return `Bearer ${h}.${p}.${createHmac('sha256', frontendAuth.accessSecret).update(`${h}.${p}`).digest('base64url')}`;
}
