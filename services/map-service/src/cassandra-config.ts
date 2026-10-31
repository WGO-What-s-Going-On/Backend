import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import cassandra from 'cassandra-driver';

export function cassandraOptions(env = process.env): cassandra.ClientOptions {
  const mode = env.CASSANDRA_MODE ?? 'local';
  if (mode !== 'local' && mode !== 'direct')
    throw new Error('CASSANDRA_MODE must be local or direct');
  if (env.NODE_ENV === 'production' && mode !== 'direct')
    throw new Error('CASSANDRA_MODE=direct is required in production');
  const contactPoints = (
    env.CASSANDRA_CONTACT_POINTS ??
    env.CASSANDRA_HOST ??
    'localhost'
  )
    .split(',')
    .map((host) => host.trim());
  if (contactPoints.some((host) => !/^[a-zA-Z0-9.-]+$/.test(host)))
    throw new Error(
      'CASSANDRA_CONTACT_POINTS must contain hostnames without credentials or ports',
    );
  const port = Number(env.CASSANDRA_PORT ?? 9042);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('CASSANDRA_PORT must be a valid port');
  const consistency = env.CASSANDRA_CONSISTENCY ?? 'localQuorum';
  if (consistency !== 'localQuorum' && consistency !== 'localOne')
    throw new Error('CASSANDRA_CONSISTENCY must be localQuorum or localOne');
  const options: cassandra.ClientOptions = {
    contactPoints,
    localDataCenter: env.CASSANDRA_DATACENTER ?? 'datacenter1',
    keyspace: env.CASSANDRA_KEYSPACE ?? 'wgo_map',
    protocolOptions: { port },
    queryOptions: {
      consistency: cassandra.types.consistencies[consistency],
      serialConsistency: cassandra.types.consistencies.localSerial,
    },
    policies: {
      // Keep conditional updates and TTL writes on server timestamps.
      // @ts-expect-error Driver 4.8 accepts null here; its declaration omits null.
      timestampGeneration: null,
    },
  };
  if (mode === 'local') {
    if (
      env.CASSANDRA_USERNAME ||
      env.CASSANDRA_PASSWORD ||
      env.CASSANDRA_CA_PATH ||
      env.CASSANDRA_TLS_MODE ||
      env.CASSANDRA_TLS_SERVER_NAME
    )
      throw new Error(
        'Use CASSANDRA_MODE=direct for authenticated TLS connections',
      );
    return options;
  }
  if (!env.CASSANDRA_CONTACT_POINTS?.trim() && !env.CASSANDRA_HOST?.trim())
    throw new Error(
      'CASSANDRA_CONTACT_POINTS is required for direct connections',
    );
  const required = (name: string) => {
    const value = env[name];
    if (!value?.trim())
      throw new Error(`${name} is required for direct connections`);
    return value;
  };
  required('CASSANDRA_KEYSPACE');
  required('CASSANDRA_DATACENTER');
  const username = required('CASSANDRA_USERNAME');
  const password = required('CASSANDRA_PASSWORD');
  const caPath = required('CASSANDRA_CA_PATH');
  if (env.CASSANDRA_TLS_MODE !== 'verify-full')
    throw new Error(
      'CASSANDRA_TLS_MODE=verify-full is required for direct connections',
    );
  const servername = env.CASSANDRA_TLS_SERVER_NAME ?? contactPoints[0];
  if (!servername || !/^[a-zA-Z0-9.-]+$/.test(servername))
    throw new Error('CASSANDRA_TLS_SERVER_NAME must be a certificate DNS name');
  let ca: string;
  try {
    ca = readFileSync(caPath, 'utf8');
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
    authProvider: new cassandra.auth.PlainTextAuthProvider(username, password),
    // The driver resolves peers to IPs. Verify the shared Service DNS SAN on every peer certificate.
    sslOptions: { ca, servername, rejectUnauthorized: true },
  };
}
