import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import cassandra from 'cassandra-driver';
import { afterAll, expect, it } from 'vitest';
import { cassandraOptions } from '../src/cassandra-config.js';

const directory = mkdtempSync(join(tmpdir(), 'wgo-cassandra-'));
const caPath = join(directory, 'ca.pem');
writeFileSync(caPath, rootCertificates[0]!);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const env = {
  NODE_ENV: 'production',
  CASSANDRA_MODE: 'direct',
  CASSANDRA_CONTACT_POINTS: 'cassandra.wgo.svc.cluster.local',
  CASSANDRA_DATACENTER: 'datacenter1',
  CASSANDRA_KEYSPACE: 'wgo_map',
  CASSANDRA_USERNAME: 'wgo_map',
  CASSANDRA_PASSWORD: 'test-password',
  CASSANDRA_TLS_MODE: 'verify-full',
  CASSANDRA_CA_PATH: caPath,
};
it('keeps unauthenticated local Cassandra defaults', () => {
  const options = cassandraOptions({});
  expect(options.contactPoints).toEqual(['localhost']);
  expect(options.protocolOptions?.port).toBe(9042);
  expect(options.sslOptions).toBeUndefined();
  expect(options.authProvider).toBeUndefined();
});
it('uses verified Service DNS TLS and password authentication with explicit consistency', () => {
  const options = cassandraOptions(env);
  expect(options.localDataCenter).toBe('datacenter1');
  expect(options.sslOptions).toMatchObject({
    rejectUnauthorized: true,
    servername: env.CASSANDRA_CONTACT_POINTS,
    ca: rootCertificates[0],
  });
  expect(options.authProvider).toBeInstanceOf(
    cassandra.auth.PlainTextAuthProvider,
  );
  expect(options.queryOptions).toMatchObject({
    consistency: cassandra.types.consistencies.localQuorum,
    serialConsistency: cassandra.types.consistencies.localSerial,
  });
  expect(options.policies?.timestampGeneration).toBeNull();
  expect(() => new cassandra.Client(options)).not.toThrow();
});
it('supports contact points with a shared TLS certificate name', () => {
  const options = cassandraOptions({
    ...env,
    CASSANDRA_CONTACT_POINTS: 'cassandra-0.cassandra, cassandra-1.cassandra',
    CASSANDRA_TLS_SERVER_NAME: 'cassandra.wgo.svc.cluster.local',
    CASSANDRA_CONSISTENCY: 'localOne',
  });
  expect(options.contactPoints).toEqual([
    'cassandra-0.cassandra',
    'cassandra-1.cassandra',
  ]);
  expect(options.queryOptions?.consistency).toBe(
    cassandra.types.consistencies.localOne,
  );
  expect(options.sslOptions?.servername).toBe(
    'cassandra.wgo.svc.cluster.local',
  );
});
it('requires explicit production credentials, topology and TLS', () => {
  for (const name of [
    'CASSANDRA_CONTACT_POINTS',
    'CASSANDRA_DATACENTER',
    'CASSANDRA_KEYSPACE',
    'CASSANDRA_USERNAME',
    'CASSANDRA_PASSWORD',
    'CASSANDRA_CA_PATH',
  ])
    expect(() => cassandraOptions({ ...env, [name]: '' })).toThrow(name);
  for (const extra of [
    { CASSANDRA_PORT: '0' },
    { CASSANDRA_PORT: '65536' },
    { CASSANDRA_MODE: 'local' },
    { CASSANDRA_MODE: 'keyspaces' },
    { CASSANDRA_TLS_MODE: 'disable' },
    { CASSANDRA_CA_PATH: '/absent' },
    { CASSANDRA_CONTACT_POINTS: 'host:9042' },
    { CASSANDRA_CONTACT_POINTS: 'host,' },
    { CASSANDRA_TLS_SERVER_NAME: 'https://host' },
    { CASSANDRA_CONSISTENCY: 'any' },
  ])
    expect(() => cassandraOptions({ ...env, ...extra })).toThrow();
});
it('rejects credentials in local mode rather than silently sending an unauthenticated connection', () => {
  expect(() =>
    cassandraOptions({
      CASSANDRA_USERNAME: 'user',
      CASSANDRA_PASSWORD: 'secret',
    }),
  ).toThrow('direct');
});
it('rejects malformed and private-key CA bundles', () => {
  for (const contents of [
    'not a certificate',
    `${rootCertificates[0]}\n-----BEGIN PRIVATE KEY-----`,
  ]) {
    const path = join(directory, 'invalid.pem');
    writeFileSync(path, contents);
    expect(() => cassandraOptions({ ...env, CASSANDRA_CA_PATH: path })).toThrow(
      'readable PEM',
    );
  }
});
