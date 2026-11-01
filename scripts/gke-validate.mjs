import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applications,
  readEnvironment,
  appResources,
  foundation,
  migrationJob,
} from './gke-lib.mjs';
import { storageResources } from './gke-storage.mjs';
const config = readEnvironment(
  process.env.GCP_ENV_FILE ?? 'deploy/gke/environment.example.json',
);
const image = (name) => `${config.registry}/${name}@sha256:${'a'.repeat(64)}`;
const items = [
  ...foundation(config),
  ...storageResources(config),
  ...applications.flatMap(([name]) => appResources(config, name, image(name))),
  ...['user-service', 'notification-service'].map((name) =>
    migrationJob(config, name, image(name), 'abcdef123456'),
  ),
];
const dir = mkdtempSync(join(tmpdir(), 'wgo-manifests-'));
try {
  const file = join(dir, 'resources.json');
  writeFileSync(
    file,
    JSON.stringify({ apiVersion: 'v1', kind: 'List', items }),
  );
  const result = spawnSync(
    process.env.KUBECONFORM ?? 'kubeconform',
    [
      '-strict',
      '-summary',
      '-kubernetes-version',
      '1.33.0',
      '-skip',
      'SecretProviderClass,ManagedCertificate,BackendConfig,FrontendConfig,Elasticsearch,ProtectedApplication',
      file,
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true });
}
