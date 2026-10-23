import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSecretJson,
  renderTask,
  validateService,
  selectReleaseServices,
  validateRelease,
} from './cd-lib.mjs';

const digest = `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/wgo/user@sha256:${'a'.repeat(64)}`;
const config = {
  ecrRepository: 'wgo/user',
  ecsService: 'user',
  containerName: 'app',
  runtimeSecretArn:
    'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:wgo/user-abcdef',
  taskDefinition: {
    family: 'user',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '256',
    memory: '512',
    executionRoleArn: 'arn:execution',
    runtimePlatform: {
      cpuArchitecture: 'X86_64',
      operatingSystemFamily: 'LINUX',
    },
    containerDefinitions: [
      {
        name: 'app',
        essential: true,
        image: 'placeholder',
        healthCheck: { command: ['CMD', 'true'] },
        environment: [
          { name: 'PASSWORD', value: 'old' },
          { name: 'OTHER', value: 'kept' },
        ],
      },
    ],
  },
};
test('secret JSON parse errors never include the secret value', () => {
  assert.throws(
    () => parseSecretJson('secret-password-not-json', 'CD_SERVICES_JSON'),
    (error) => !error.message.includes('secret-password'),
  );
});
test('renders immutable image and version-pinned secret references without plaintext', () => {
  const before = JSON.stringify(config);
  const rendered = renderTask(
    config,
    digest,
    { NODE_ENV: 'production', PASSWORD: 'super-secret' },
    'a'.repeat(32),
  );
  assert.equal(rendered.containerDefinitions[0].image, digest);
  assert.deepEqual(rendered.containerDefinitions[0].environment, [
    { name: 'OTHER', value: 'kept' },
  ]);
  assert.equal(
    rendered.containerDefinitions[0].secrets[1].valueFrom,
    `${config.runtimeSecretArn}:PASSWORD::${'a'.repeat(32)}`,
  );
  assert.ok(!JSON.stringify(rendered).includes('super-secret'));
  assert.equal(JSON.stringify(config), before);
});
test('rejects mutable images, unsafe env names, and development runtime', () => {
  assert.throws(() =>
    renderTask(
      config,
      'image:latest',
      { NODE_ENV: 'production' },
      'a'.repeat(32),
    ),
  );
  assert.throws(() =>
    renderTask(
      config,
      digest,
      { NODE_ENV: 'production', 'BAD:KEY': 'x' },
      'a'.repeat(32),
    ),
  );
  assert.throws(() =>
    renderTask(config, digest, { NODE_ENV: 'development' }, 'a'.repeat(32)),
  );
});
test('requires health checks and matching Fargate architecture', () => {
  assert.equal(validateService('user-service', config, 'linux/amd64'), config);
  assert.throws(() => validateService('user-service', config, 'linux/arm64'));
  const invalid = structuredClone(config);
  delete invalid.taskDefinition.containerDefinitions[0].healthCheck;
  assert.throws(() => validateService('user-service', invalid, 'linux/amd64'));
});
test('uses receiver-first deployment order and rejects unknown service names', () => {
  const manifest = {
    services: [
      { name: 'ws-gateway', path: 'gateways/ws-gateway' },
      { name: 'post-service', path: 'services/post-service' },
    ],
  };
  assert.deepEqual(
    selectReleaseServices(manifest, {
      'ws-gateway': {},
      'post-service': {},
    }).map((entry) => entry.name),
    ['post-service', 'ws-gateway'],
  );
  assert.throws(() => selectReleaseServices(manifest, { unknown: {} }));
});
test('release promotion requires exact source SHA and digest for every entry', () => {
  const sha = 'b'.repeat(40);
  const release = {
    sha,
    services: [{ name: 'user-service', sourceSha: sha, image: digest }],
  };
  assert.equal(validateRelease(release, sha), release);
  assert.throws(() => validateRelease(release, 'c'.repeat(40)));
  assert.throws(() =>
    validateRelease(
      { ...release, services: [...release.services, ...release.services] },
      sha,
    ),
  );
});

test('CI is PR-only and CD accepts only merged main PRs before checkout', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const workflow = readFileSync(
    new URL('../.github/workflows/cd.yml', import.meta.url),
    'utf8',
  );
  const ci = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(ci, /pull_request:\s+types: \[opened, synchronize, reopened\]/);
  assert.doesNotMatch(ci, /\n  (?:push|workflow_dispatch|workflow_run):/);
  assert.match(
    workflow,
    /pull_request_target:\s+types: \[closed\]\s+branches: \[main\]/,
  );
  assert.match(workflow, /if: github.event.pull_request.merged == true/);
  assert.doesNotMatch(
    workflow,
    /workflow_run|workflow_dispatch|pull_request.head.sha/,
  );
  assert.ok(
    workflow.indexOf('Reject untrusted release source before checkout') <
      workflow.indexOf('uses: actions/checkout'),
  );
  const inline = workflow.match(
    /node --input-type=module <<'JS'\n([\s\S]*?)\n          JS/,
  )[1];
  const code = inline.replace(/import \{ readFileSync \} from 'node:fs';/, '');
  const sha = 'a'.repeat(40);
  const event = {
    action: 'closed',
    pull_request: {
      merged: true,
      merge_commit_sha: sha,
      base: { ref: 'main', repo: { full_name: 'org/repo' } },
    },
  };
  const check = (value, name = 'pull_request_target') =>
    runInNewContext(code, {
      readFileSync: () => JSON.stringify(value),
      process: {
        env: {
          GITHUB_EVENT_NAME: name,
          GITHUB_REPOSITORY: 'org/repo',
          CD_SHA: sha,
        },
      },
    });
  assert.doesNotThrow(() => check(event));
  assert.throws(() => check(event, 'push'));
  for (const patch of [
    { merged: false },
    { merge_commit_sha: 'b'.repeat(40) },
    { base: { ref: 'develop', repo: { full_name: 'org/repo' } } },
    { base: { ref: 'main', repo: { full_name: 'other/repo' } } },
  ])
    assert.throws(() =>
      check({ ...event, pull_request: { ...event.pull_request, ...patch } }),
    );
  assert.throws(() => check({ ...event, action: 'opened' }));
});

test('release artifact supports re-running all jobs after a production failure', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(
    new URL('../.github/workflows/cd.yml', import.meta.url),
    'utf8',
  );
  const upload = workflow.slice(
    workflow.indexOf('uses: actions/upload-artifact@v4'),
    workflow.indexOf('- name: Remove registry credentials'),
  );
  assert.match(upload, /overwrite: true/);
});
