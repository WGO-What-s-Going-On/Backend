import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import cassandra from 'cassandra-driver';
import { KeyspacesAuthProvider } from './keyspaces-auth.js';

export function cassandraOptions(env = process.env): cassandra.ClientOptions {
  const mode = env.CASSANDRA_MODE ?? 'local';
  if (!['local', 'keyspaces'].includes(mode))
    throw new Error('CASSANDRA_MODE must be local or keyspaces');
  const keyspaces = mode === 'keyspaces';
  if (env.NODE_ENV === 'production' && !keyspaces)
    throw new Error('CASSANDRA_MODE=keyspaces is required in production');
  if (keyspaces) {
    for (const name of [
      'CASSANDRA_HOST',
      'CASSANDRA_KEYSPACE',
      'AWS_REGION',
      'CASSANDRA_CA_PATH',
    ])
      if (!env[name]?.trim())
        throw new Error(`${name} is required for Keyspaces`);
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
    ])
      if (env.NODE_ENV === 'production' && env[name])
        throw new Error(
          `${name} must be unset in production; use the ECS Task Role`,
        );
    if (env.CASSANDRA_DATACENTER && env.CASSANDRA_DATACENTER !== env.AWS_REGION)
      throw new Error(
        'CASSANDRA_DATACENTER must match AWS_REGION for Keyspaces',
      );
  }
  const port = Number(env.CASSANDRA_PORT ?? (keyspaces ? 9142 : 9042));
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (keyspaces && port !== 9142)
  )
    throw new Error('CASSANDRA_PORT must be a valid port (9142 for Keyspaces)');
  const host = env.CASSANDRA_HOST ?? 'localhost';
  if (!/^[a-zA-Z0-9.-]+$/.test(host))
    throw new Error(
      'CASSANDRA_HOST must be a hostname without credentials or port',
    );
  const options: cassandra.ClientOptions = {
    contactPoints: [host],
    localDataCenter: keyspaces
      ? env.AWS_REGION!
      : (env.CASSANDRA_DATACENTER ?? 'datacenter1'),
    keyspace: env.CASSANDRA_KEYSPACE ?? 'wgo_map',
    protocolOptions: { port },
  };
  if (!keyspaces) return options;
  let ca: string;
  try {
    ca = readFileSync(env.CASSANDRA_CA_PATH!, 'utf8');
    const certificates = ca.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (!certificates?.length || /PRIVATE KEY/.test(ca)) throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch {
    throw new Error(
      'CASSANDRA_CA_PATH must reference a readable PEM CA certificate bundle',
    );
  }
  return {
    ...options,
    // 재연결마다 갱신 가능한 credential provider로 ECS 임시 자격 증명을 조회한다.
    authProvider: new KeyspacesAuthProvider(env.AWS_REGION!),
    // 드라이버는 endpoint를 IP로 해석하므로 인증서 검증 이름을 DNS 이름으로 유지한다.
    sslOptions: { ca, servername: host, rejectUnauthorized: true },
    queryOptions: { consistency: cassandra.types.consistencies.localQuorum },
    policies: {
      // 현재 쓰기는 서버 시각을 사용한다. 테이블의 client-side timestamps 활성화를 요구하지 않는다.
      // @ts-expect-error Driver 4.8 accepts null here; its declaration omits null.
      timestampGeneration: null,
      loadBalancing:
        new cassandra.policies.loadBalancing.DCAwareRoundRobinPolicy(
          env.AWS_REGION!,
        ),
    },
  };
}
