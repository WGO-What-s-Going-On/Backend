import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const profile of ['autopilot', 'standard-demo']) {
  test(`identity bootstrap binds RBAC with the ${profile} context`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'wgo-identity-'));
    try {
      const config = JSON.parse(
        readFileSync('deploy/gke/environment.example.json'),
      );
      if (profile === 'standard-demo') {
        config.deploymentProfile = profile;
        config.clusterLocation = 'asia-northeast3-a';
        config.replicas = 1;
      }
      const context = `gke_${config.project}_${config.clusterLocation ?? config.region}_${config.cluster}`;
      const file = join(dir, 'environment.json');
      const bound = join(dir, 'rbac.json');
      writeFileSync(file, JSON.stringify(config));
      writeFileSync(
        join(dir, 'gcloud'),
        `#!/bin/sh
case "$*" in
  *'projects describe'*) echo 123456 ;;
  *'list'*) echo '[]' ;;
esac
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(dir, 'kubectl'),
        `#!/bin/sh
case "$1" in
  config) printf '%s' "$TEST_CONTEXT" ;;
  apply) cat > "$TEST_BOUND" ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o700 },
      );
      const run = (selected) =>
        spawnSync(
          process.execPath,
          ['scripts/gcp-cicd-identity.mjs', '--apply'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              GCP_ENV_FILE: file,
              GITHUB_REPOSITORY: 'owner/repo',
              TEST_CONTEXT: selected,
              TEST_BOUND: bound,
            },
          },
        );
      const rejected = run('gke_wrong_project');
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Select the configured GKE context/);
      const accepted = run(context);
      assert.equal(accepted.status, 0, accepted.stderr);
      const resources = JSON.parse(readFileSync(bound));
      assert.equal(
        resources.items.find((r) => r.kind === 'RoleBinding').metadata
          .namespace,
        config.namespace,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
