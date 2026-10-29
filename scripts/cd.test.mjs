import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSecretJson,
  renderTask,
  deploymentRuntime,
  deploymentRuntimeChanged,
  validateService,
  selectReleaseServices,
  validateRelease,
  waitForDeployment,
} from './cd-lib.mjs';

test('stable task count can precede rollout completion without triggering rollback', async () => {
  let reads = 0;
  let pauses = 0;
  assert.equal(
    await waitForDeployment(
      () => ({
        taskDefinition: 'new-task',
        desiredCount: 1,
        runningCount: 1,
        pendingCount: 0,
        deployments: [
          {
            taskDefinition: 'new-task',
            rolloutState: ++reads < 3 ? 'IN_PROGRESS' : 'COMPLETED',
          },
        ],
      }),
      'new-task',
      async () => {
        pauses++;
      },
    ),
    true,
  );
  assert.equal(reads, 3);
  assert.equal(pauses, 2);
});
test('rollout waiting is bounded and rejects rollback or failure immediately', async () => {
  const service = {
    taskDefinition: 'new-task',
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    deployments: [{ taskDefinition: 'new-task', rolloutState: 'IN_PROGRESS' }],
  };
  let pauses = 0;
  assert.equal(
    await waitForDeployment(
      () => service,
      'new-task',
      async () => {
        pauses++;
      },
      3,
    ),
    false,
  );
  assert.equal(pauses, 2);
  for (const result of [
    undefined,
    { ...service, taskDefinition: 'old-task' },
    {
      ...service,
      deployments: [{ taskDefinition: 'new-task', rolloutState: 'FAILED' }],
    },
  ]) {
    assert.equal(
      await waitForDeployment(
        () => result,
        'new-task',
        async () => {
          assert.fail('must not wait');
        },
      ),
      false,
    );
  }
});

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

test('CI is PR-only and CD accepts main pushes or explicit main staging dispatches', async () => {
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
  assert.match(workflow, /push:\s+branches: \[main\]/);
  assert.doesNotMatch(
    workflow,
    /workflow_run|pull_request_target|merge_commit_sha/,
  );
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+initial_deployment:/);
  assert.match(
    workflow,
    /production:\s+needs: staging\s+if: github.event_name == 'push'/,
  );
  assert.match(
    workflow,
    /CD_INITIAL_DEPLOYMENT: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.initial_deployment/,
  );
  assert.equal(
    (workflow.match(/CD_SHA: \$\{\{ github.sha \}\}/g) ?? []).length,
    3,
  );
  assert.equal(
    (workflow.match(/ref: \$\{\{ github.sha \}\}/g) ?? []).length,
    2,
  );
  assert.equal(
    (workflow.match(/name: release-\$\{\{ github.sha \}\}/g) ?? []).length,
    2,
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
    ref: 'refs/heads/main',
    after: sha,
    deleted: false,
    repository: { full_name: 'org/repo' },
  };
  const check = (value, overrides = {}) =>
    runInNewContext(code, {
      readFileSync: () => JSON.stringify(value),
      process: {
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REPOSITORY: 'org/repo',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_SHA: sha,
          CD_SHA: sha,
          ...overrides,
        },
      },
    });
  assert.doesNotThrow(() => check(event));
  const dispatch = {
    repository: event.repository,
    inputs: { initial_deployment: 'true' },
  };
  assert.doesNotThrow(() =>
    check(dispatch, { GITHUB_EVENT_NAME: 'workflow_dispatch' }),
  );
  assert.doesNotThrow(() =>
    check(
      { ...dispatch, inputs: { initial_deployment: 'false' } },
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    ),
  );
  assert.throws(() =>
    check(dispatch, {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/dev',
    }),
  );
  assert.throws(() =>
    check(
      { ...dispatch, inputs: { initial_deployment: 'yes' } },
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    ),
  );
  for (const patch of [
    { ref: 'refs/heads/dev' },
    { ref: 'refs/tags/main' },
    { deleted: true },
    { after: 'b'.repeat(40) },
    { after: '0'.repeat(40) },
    { after: 'invalid' },
    { repository: { full_name: 'other/repo' } },
    { repository: undefined },
  ])
    assert.throws(() => check({ ...event, ...patch }));
  for (const overrides of [
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF: 'refs/heads/dev' },
    { GITHUB_SHA: 'b'.repeat(40) },
    { CD_SHA: 'b'.repeat(40) },
  ])
    assert.throws(() => check(event, overrides));
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

test('staging docs and frontend origins do not leak into production', () => {
  const input = { NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example' };
  const staging = deploymentRuntime('http-gateway', 'staging', input);
  assert.equal(staging.DOCS_ENABLED, 'true');
  assert.equal(staging.DEPLOYMENT_ENV, 'staging');
  assert.equal(staging.NODE_ENV, 'production');
  assert.equal(
    staging.CORS_ORIGINS,
    'https://app.example,http://localhost:3000,http://localhost:5173',
  );
  assert.equal(input.CORS_ORIGINS, 'https://app.example');
  const production = deploymentRuntime('http-gateway', 'production', {
    ...input,
    DOCS_ENABLED: 'true',
    DEPLOYMENT_ENV: 'staging',
  });
  assert.equal(production.DOCS_ENABLED, 'false');
  assert.equal(production.DEPLOYMENT_ENV, 'production');
  assert.equal(production.CORS_ORIGINS, input.CORS_ORIGINS);
  assert.match(
    deploymentRuntime('ws-gateway', 'staging', input).WS_ALLOWED_ORIGINS,
    /http:\/\/localhost:5173/,
  );
});

test('CD runtime setting changes redeploy both gateways, not unrelated services', () => {
  for (const name of ['http-gateway', 'ws-gateway']) {
    assert.equal(deploymentRuntimeChanged(name, ['scripts/cd-lib.mjs']), true);
    assert.equal(deploymentRuntimeChanged(name, ['scripts/cd.mjs']), true);
    assert.equal(
      deploymentRuntimeChanged(name, ['scripts/cd.test.mjs']),
      false,
    );
  }
  assert.equal(
    deploymentRuntimeChanged('user-service', ['scripts/cd-lib.mjs']),
    false,
  );
});
