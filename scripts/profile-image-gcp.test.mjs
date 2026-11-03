import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appResources } from './gke-lib.mjs';

test('profile bucket IAM is isolated from Post and uses signBlob alone', () => {
  const result = spawnSync(process.execPath, ['scripts/gcp-bootstrap.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GCP_ENV_FILE: 'deploy/gke/environment.example.json',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const commands = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('['))
    .map(JSON.parse);
  const profileCommands = commands.filter((cmd) =>
    cmd.some((part) => String(part).includes('-profiles')),
  );
  assert(
    profileCommands.some((cmd) => cmd.includes('--public-access-prevention')),
  );
  assert(
    profileCommands.some((cmd) =>
      cmd.includes(
        '--role=projects/replace-project-id/roles/wgoProfileObjects',
      ),
    ),
  );
  assert(
    !profileCommands.some((cmd) =>
      cmd.some((part) => part.includes('post-service')),
    ),
  );
  assert(
    commands.some((cmd) =>
      cmd.includes('--permissions=iam.serviceAccounts.signBlob'),
    ),
  );
  const userBindings = commands.filter(
    (cmd) =>
      cmd.includes('add-iam-policy-binding') &&
      cmd.some((part) =>
        part.includes('--member=serviceAccount:wgo-demo-user-service@'),
      ),
  );
  assert(
    !userBindings.some((cmd) =>
      cmd.includes('--role=roles/iam.serviceAccountTokenCreator'),
    ),
  );
  assert(
    !commands.some((cmd) => cmd.includes('keys') && cmd.includes('create')),
  );
  assert(
    profileCommands.some((cmd) =>
      cmd.some((part) => part.startsWith('--cors-file=')),
    ),
  );
  assert(
    profileCommands.some((cmd) =>
      cmd.some((part) => part.startsWith('--lifecycle-file=')),
    ),
  );
  assert(
    commands.some(
      (cmd) =>
        cmd.includes('gs://replace-project-id-wgo-demo-media') &&
        cmd.includes('--role=roles/storage.objectAdmin'),
    ),
  );
});
test('User deployment enables its own profile bucket without credential files', () => {
  const config = JSON.parse(
    readFileSync('deploy/gke/environment.example.json'),
  );
  const resources = appResources(
    config,
    'user-service',
    `${config.registry}/user-service@sha256:${'a'.repeat(64)}`,
  );
  const settings = resources.find((item) => item.kind === 'ConfigMap').data;
  assert.equal(settings.GCS_PROFILE_ENABLED, 'true');
  assert.equal(
    settings.GCS_PROFILE_BUCKET,
    `${config.project}-${config.namespace}-profiles`,
  );
  assert.equal(settings.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});
