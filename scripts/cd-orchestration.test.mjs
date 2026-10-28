import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const registry = '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com';
const image = `${registry}/wgo/user-service@sha256:${'a'.repeat(64)}`;
const task = {
  ecrRepository: 'wgo/user-service',
  ecsService: 'user',
  containerName: 'app',
  runtimeSecretArn:
    'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:user-abcdef',
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
      },
    ],
  },
};
const fake = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const path = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const op = args.slice(0, 2).join(' ');
appendFileSync(process.env.FAKE_LOG, op + '\\n');
const get = name => args[args.indexOf(name) + 1];
let result = {};
if (op === 'sts get-caller-identity') result = { Account: '123456789012' };
else if (op === 'ssm get-parameters') {
  if (state.denied) process.exit(1);
  result = { Parameters: state.previous ? [{ Value: JSON.stringify(state.previous) }] : [], InvalidParameters: state.previous ? [] : [get('--names')] };
} else if (op === 'ecr describe-images') result = { imageDetails: [{ imageDigest: 'sha256:' + 'a'.repeat(64) }] };
else if (op === 'ecs describe-services') result = { services: [{ status: 'ACTIVE', desiredCount: state.desiredCount ?? 1, runningCount: state.noRunning ? 0 : (state.desiredCount ?? 1), pendingCount: 0, deploymentController: { type: 'ECS' }, taskDefinition: state.autoRollback && state.updated === 'new-task' ? 'old-task' : (state.updated || 'old-task'), networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet'], securityGroups: ['sg'], assignPublicIp: 'DISABLED' } }, deployments: [{ taskDefinition: state.autoRollback && state.updated === 'new-task' ? 'old-task' : (state.updated || 'old-task'), rolloutState: state.inProgress ? 'IN_PROGRESS' : 'COMPLETED' }] }] };
else if (op === 'secretsmanager put-secret-value') result = { VersionId: 'a'.repeat(32) };
else if (op === 'ecs register-task-definition') {
  const content = readFileSync(get('--cli-input-json').slice(7), 'utf8');
  if (content.includes('do-not-leak')) process.exit(8);
  result = { taskDefinition: { taskDefinitionArn: 'new-task' } };
} else if (op === 'ecs update-service') {
  state.updated = get('--task-definition');
  (state.updates ??= []).push(args);
  if (args.includes('--desired-count')) state.desiredCount = Number(get('--desired-count'));
}
else if (op === 'ecs run-task') result = { tasks: [{ taskArn: 'smoke-task' }] };
else if (op === 'ecs describe-tasks') result = { tasks: [{ containers: [{ name: 'app', exitCode: state.smokeFailed ? 1 : 0 }] }] };
else if (op === 'ssm put-parameter') state.saved = JSON.parse(get('--value'));
writeFileSync(path, JSON.stringify(state));
console.log(JSON.stringify(result));
`;

function fixture(t, initial = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wgo-cd-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'services/user-service/src'), { recursive: true });
  for (const name of ['cd.mjs', 'cd-lib.mjs', 'ci-lib.mjs', 'ci-services.json'])
    copyFileSync(new URL(name, import.meta.url), join(dir, 'scripts', name));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'bin/aws'), fake, { mode: 0o755 });
  writeFileSync(
    join(dir, 'bin/docker'),
    '#!/bin/sh\nprintf "docker build\\n" >> "$FAKE_LOG"\n',
    { mode: 0o755 },
  );
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'CD Test');
  git('config', 'user.email', 'cd@example.invalid');
  writeFileSync(join(dir, 'services/user-service/src/main.ts'), 'old');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const previousSha = git('rev-parse', 'HEAD');
  writeFileSync(
    join(
      dir,
      options.docsOnly ? 'README.md' : 'services/user-service/src/main.ts',
    ),
    'new',
  );
  git('add', '.');
  git('commit', '-qm', 'next');
  const sha = git('rev-parse', 'HEAD');
  const state = { ...initial };
  if (options.previous)
    state.previous = {
      sha: previousSha,
      image: options.previousImage ?? image,
      taskDefinition: 'old-task',
    };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'calls.log'), '');
  const config = structuredClone(task);
  if (options.smoke) config.smokeCommand = ['node', '-e', 'process.exit(0)'];
  if (options.migration) config.migrationCommand = ['node', 'migrate.js'];
  const env = {
    ...process.env,
    PATH: `${dir}/bin:${process.env.PATH}`,
    FAKE_STATE: join(dir, 'state.json'),
    FAKE_LOG: join(dir, 'calls.log'),
    CD_SHA: sha,
    AWS_ACCOUNT_ID: '123456789012',
    ECS_CLUSTER: 'cluster',
    ECR_REGISTRY: registry,
    CD_IMAGE_PLATFORM: 'linux/amd64',
    CD_STATE_PREFIX: '/wgo/test',
    CD_SERVICES_JSON: JSON.stringify({
      'user-service': config,
      ...(options.twoServices ? { 'map-service': config } : {}),
    }),
    CD_RUNTIME_SECRETS_JSON: JSON.stringify({
      'user-service': { NODE_ENV: 'production', PASSWORD: 'do-not-leak' },
      ...(options.twoServices
        ? { 'map-service': { NODE_ENV: 'production' } }
        : {}),
    }),
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    CD_FORCE_SERVICES: options.force ? 'user-service' : '',
    CD_INITIAL_DEPLOYMENT: options.initial ? 'true' : 'false',
  };
  return {
    dir,
    sha,
    previousSha,
    execute(mode = 'staging') {
      const result = spawnSync(process.execPath, ['scripts/cd.mjs', mode], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      assert.ok(
        !result.stdout.includes('do-not-leak') &&
          !result.stderr.includes('do-not-leak'),
      );
      return {
        ...result,
        state: JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
        calls: readFileSync(join(dir, 'calls.log'), 'utf8'),
      };
    },
  };
}

test('records successful deployment only after completed revision and smoke', (t) => {
  const setup = fixture(t, {}, { smoke: true });
  const result = setup.execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.saved.sha, setup.sha);
  assert.equal(result.state.saved.image, image);
  assert.ok(
    result.calls.indexOf('ecs describe-tasks') <
      result.calls.indexOf('ssm put-parameter'),
  );
  const release = JSON.parse(
    readFileSync(join(setup.dir, 'release.json'), 'utf8'),
  );
  assert.deepEqual(release.services, [
    { name: 'user-service', image, sourceSha: setup.sha },
  ]);
});
test('automatic ECS rollback is not accepted as successful deployment', (t) => {
  const result = fixture(t, { autoRollback: true }).execute();
  assert.equal(result.status, 1);
  assert.equal(result.state.updated, 'old-task');
  assert.equal(result.state.saved, undefined);
});
test('smoke failure restores previous task and does not advance state', (t) => {
  const result = fixture(t, { smokeFailed: true }, { smoke: true }).execute();
  assert.equal(result.status, 1);
  assert.equal(result.state.updated, 'old-task');
  assert.equal(result.state.saved, undefined);
});
test('SSM access denied is not treated as first deployment', (t) => {
  const result = fixture(t, { denied: true }).execute();
  assert.equal(result.status, 1);
  assert.ok(!result.calls.includes('docker build'));
  assert.equal(result.state.updated, undefined);
});
test('unchanged staged service still promotes to catch up previous production failure', (t) => {
  const setup = fixture(t, {}, { previous: true, docsOnly: true });
  const staged = setup.execute();
  assert.equal(staged.status, 0, staged.stderr);
  assert.ok(!staged.calls.includes('docker build'));
  writeFileSync(
    join(setup.dir, 'state.json'),
    JSON.stringify({
      previous: {
        sha: setup.previousSha,
        image: image.replace(/a{64}$/, 'b'.repeat(64)),
        taskDefinition: 'old-task',
      },
    }),
  );
  const promoted = setup.execute('production');
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.equal(promoted.state.saved.image, image);
  assert.ok(!promoted.calls.includes('docker build'));
});
test('manual force rebuilds even with only documentation changes', (t) => {
  const result = fixture(
    t,
    {},
    { previous: true, docsOnly: true, force: true },
  ).execute();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.includes('docker build'));
  assert.equal(result.state.saved.image, image);
});

test('zero count is rejected without explicit initial deployment before pushing images', (t) => {
  const result = fixture(t, { desiredCount: 0 }).execute();
  assert.equal(result.status, 1);
  assert.ok(!result.calls.includes('docker build'));
  assert.equal(result.state.updated, undefined);
});
test('initial staging deployment migrates then starts one task and saves verified state', (t) => {
  const result = fixture(
    t,
    { desiredCount: 0 },
    { initial: true, migration: true },
  ).execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.desiredCount, 1);
  assert.equal(result.state.saved.image, image);
  assert.ok(
    result.calls.indexOf('ecs describe-tasks') <
      result.calls.indexOf('ecs update-service'),
  );
});
test('initial option never restarts a previously deployed stopped service', (t) => {
  const result = fixture(
    t,
    { desiredCount: 0 },
    { initial: true, previous: true, docsOnly: true },
  ).execute();
  assert.equal(result.status, 1);
  assert.equal(result.state.updated, undefined);
});
test('failed initial smoke restores the stopped state without recording success', (t) => {
  const result = fixture(
    t,
    { desiredCount: 0, smokeFailed: true },
    { initial: true, smoke: true },
  ).execute();
  assert.equal(result.status, 1);
  assert.equal(result.state.desiredCount, 0);
  assert.equal(result.state.updated, 'old-task');
  assert.equal(result.state.saved, undefined);
});
test('failed initial migration never starts the service', (t) => {
  const result = fixture(
    t,
    { desiredCount: 0, smokeFailed: true },
    { initial: true, migration: true },
  ).execute();
  assert.equal(result.status, 1);
  assert.equal(result.state.desiredCount, 0);
  assert.equal(result.state.updated, undefined);
});
test('initial option preserves the running task count on subsequent deployments', (t) => {
  const result = fixture(
    t,
    { desiredCount: 3 },
    { initial: true, previous: true },
  ).execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.desiredCount, 3);
  assert.ok(
    result.state.updates.every((args) => !args.includes('--desired-count')),
  );
});
test('initial option is rejected in production before AWS access', (t) => {
  const result = fixture(t, {}, { initial: true }).execute('production');
  assert.equal(result.status, 1);
  assert.equal(result.calls, '');
});
test('all images are pushed before any migration or service update', (t) => {
  const result = fixture(
    t,
    {},
    { twoServices: true, migration: true },
  ).execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.calls.match(/docker build/g) ?? []).length, 2);
  assert.ok(
    result.calls.lastIndexOf('docker build') <
      result.calls.indexOf('ecs run-task'),
  );
});
test('completed deployment without running tasks is not accepted', (t) => {
  const result = fixture(t, { noRunning: true }).execute();
  assert.equal(result.status, 1);
  assert.equal(result.state.saved, undefined);
});
test('initial option does not interrupt an in-progress deployment', (t) => {
  const result = fixture(
    t,
    { desiredCount: 0, inProgress: true },
    { initial: true },
  ).execute();
  assert.equal(result.status, 1);
  assert.equal(result.state.updated, undefined);
});
