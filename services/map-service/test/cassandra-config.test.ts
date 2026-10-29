import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import cassandra from 'cassandra-driver';
import { afterAll, expect, it, vi } from 'vitest';
import { cassandraOptions } from '../src/cassandra-config.js';
import { KeyspacesAuthProvider } from '../src/keyspaces-auth.js';

const directory = mkdtempSync(join(tmpdir(), 'wgo-keyspaces-'));
const caPath = join(directory, 'ca.pem');
writeFileSync(caPath, rootCertificates[0]!);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const env = {
  NODE_ENV: 'production',
  CASSANDRA_MODE: 'keyspaces',
  CASSANDRA_HOST: 'cassandra.example',
  CASSANDRA_KEYSPACE: 'wgo_map',
  AWS_REGION: 'ap-northeast-2',
  CASSANDRA_CA_PATH: caPath,
};
it('loads Keyspaces authentication in native Node ESM without bundler interop', () => {
  const source = readFileSync(
    new URL('../src/keyspaces-auth.ts', import.meta.url),
    'utf8',
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
    },
  });
  // Vitest's module transform can hide imports that fail in the production Node process.
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', outputText],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
});
it('keeps local Cassandra defaults', () => {
  const options = cassandraOptions({});
  expect(options.contactPoints).toEqual(['localhost']);
  expect(options.protocolOptions?.port).toBe(9042);
  expect(options.sslOptions).toBeUndefined();
  expect(options.authProvider).toBeUndefined();
});
it('configures verified TLS, refreshable auth and Keyspaces consistency', () => {
  const options = cassandraOptions(env);
  expect(options.protocolOptions?.port).toBe(9142);
  expect(options.localDataCenter).toBe(env.AWS_REGION);
  expect(options.sslOptions).toMatchObject({
    rejectUnauthorized: true,
    servername: env.CASSANDRA_HOST,
    ca: rootCertificates[0],
  });
  expect(options.authProvider).toBeInstanceOf(KeyspacesAuthProvider);
  expect(options.policies?.timestampGeneration).toBeNull();
  expect(() => new cassandra.Client(options)).not.toThrow();
  expect(options.queryOptions?.consistency).toBe(
    cassandra.types.consistencies.localQuorum,
  );
});
it('rejects incomplete or unsafe production settings', () => {
  for (const name of [
    'CASSANDRA_HOST',
    'CASSANDRA_KEYSPACE',
    'AWS_REGION',
    'CASSANDRA_CA_PATH',
  ])
    expect(() => cassandraOptions({ ...env, [name]: '' })).toThrow(name);
  for (const extra of [
    { CASSANDRA_PORT: '9042' },
    { CASSANDRA_DATACENTER: 'datacenter1' },
    { CASSANDRA_MODE: 'local' },
    { AWS_ACCESS_KEY_ID: 'do-not-print' },
    { CASSANDRA_CA_PATH: '/absent' },
  ])
    expect(() => cassandraOptions({ ...env, ...extra })).toThrow();
});
it('resolves credentials for every reconnect and signs with the current session token', async () => {
  const credentials = vi
    .fn()
    .mockResolvedValueOnce({
      accessKeyId: 'test-1',
      secretAccessKey: 'test-secret',
      sessionToken: 'test-token-1',
    })
    .mockResolvedValueOnce({
      accessKeyId: 'test-2',
      secretAccessKey: 'test-secret',
      sessionToken: 'test-token-2',
    });
  const provider = new KeyspacesAuthProvider('ap-northeast-2', credentials);
  for (const token of ['test-token-1', 'test-token-2']) {
    const auth = provider.newAuthenticator('cassandra.example:9142', 'test');
    await new Promise<void>((resolve, reject) =>
      auth.initialResponse((error) => (error ? reject(error) : resolve())),
    );
    const signed = await new Promise<Buffer>((resolve, reject) =>
      auth.evaluateChallenge(
        Buffer.from('nonce=test-nonce'),
        (error, response) => (error ? reject(error) : resolve(response!)),
      ),
    );
    expect(signed.toString()).toContain(`session_token=${token}`);
  }
  expect(credentials).toHaveBeenCalledTimes(2);
});
it('returns credential lookup failures to the driver without exposing metadata', async () => {
  const provider = new KeyspacesAuthProvider(
    'ap-northeast-2',
    vi.fn().mockRejectedValue(new Error('sensitive provider error')),
  );
  const auth = provider.newAuthenticator('cassandra.example:9142', 'test');
  const error = await new Promise<Error | null>((resolve) =>
    auth.initialResponse((error) => resolve(error)),
  );
  expect(error?.message).toBe('Keyspaces Task Role credentials unavailable');
});
