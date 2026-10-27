import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

// 앱과 migration이 같은 검증 정책을 사용해야 배포 중 연결 정책이 달라지지 않는다.
export function databaseTls(
  env = process.env,
): false | { ca: string; rejectUnauthorized: true } {
  const mode = env.DB_TLS_MODE ?? 'disable';
  if (!['disable', 'verify-full'].includes(mode))
    throw new Error('DB_TLS_MODE must be disable or verify-full');
  if (env.NODE_ENV === 'production' && mode !== 'verify-full')
    throw new Error('DB_TLS_MODE=verify-full is required in production');
  if (mode === 'disable') {
    if (env.DB_TLS_CA_PATH)
      throw new Error('DB_TLS_CA_PATH requires DB_TLS_MODE=verify-full');
    return false;
  }
  if (!env.DB_TLS_CA_PATH?.trim())
    throw new Error('DB_TLS_CA_PATH is required for verify-full');
  try {
    const ca = readFileSync(env.DB_TLS_CA_PATH, 'utf8');
    const certificates = ca.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (!certificates?.length || /PRIVATE KEY/.test(ca)) throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
    return { ca, rejectUnauthorized: true };
  } catch {
    throw new Error(
      'DB_TLS_CA_PATH must reference a readable PEM CA certificate bundle',
    );
  }
}
