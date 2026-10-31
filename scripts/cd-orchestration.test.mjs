import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
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
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const args = process.argv.slice(2);
const op = args.slice(0, 2).join(' ');
const get = name => args[args.indexOf(name) + 1];
const configs = JSON.parse(process.env.CD_SERVICES_JSON);
const input = args.includes('--cli-input-json') ? JSON.parse(readFileSync(get('--cli-input-json').slice(7), 'utf8')) : undefined;
const revision = name => name === 'user-service' ? 'new-task' : name + ':new-task';
const serviceName = Object.keys(configs).find(name => {
  const config = configs[name];
  return (args.includes('--names') && get('--names').endsWith('/' + name)) ||
    (args.includes('--name') && get('--name').endsWith('/' + name)) ||
    ['--service', '--services'].some(flag => args.includes(flag) && get(flag) === config.ecsService) ||
    (args.includes('--repository-name') && get('--repository-name') === config.ecrRepository) ||
    (args.includes('--secret-id') && get('--secret-id') === config.runtimeSecretArn) ||
    input?.family === config.taskDefinition.family || input?.taskDefinition === revision(name) ||
    (args.includes('--tasks') && get('--tasks') === name + ':smoke-task') ||
    (op === 'buildx build' && args.at(-1).endsWith('/' + name));
});
const statePath = serviceName && join(process.env.FAKE_STATE_DIR, serviceName + '.json');
const state = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const log = message => appendFileSync(process.env.FAKE_LOG, message + '\\n');
log((op === 'buildx build' ? 'docker build' : op) + ' ' + (serviceName ?? ''));
async function barrier(phase) {
  const names = (process.env['FAKE_' + phase.toUpperCase() + '_BARRIER'] ?? '').split(',').filter(Boolean);
  if (!names.includes(serviceName)) return;
  writeFileSync(join(process.env.FAKE_STATE_DIR, phase + '-' + serviceName), 'entered');
  const deadline = Date.now() + 10000;
  while (!names.every(name => existsSync(join(process.env.FAKE_STATE_DIR, phase + '-' + name)))) {
    if (Date.now() >= deadline) throw new Error('Concurrent peer did not enter ' + phase);
    await pause(10);
  }
}
let result = {};
let changed = false;
if (op === 'buildx build') {
  await barrier('build');
  if (state.buildFailed) process.exit(1);
  log('docker complete ' + serviceName);
} else if (op === 'sts get-caller-identity') result = { Account: '123456789012' };
else if (op === 'ssm get-parameters') {
  if (state.denied) process.exit(1);
  result = { Parameters: state.previous ? [{ Value: JSON.stringify(state.previous) }] : [], InvalidParameters: state.previous ? [] : [get('--names')] };
} else if (op === 'ecr describe-images') result = { imageDetails: [{ imageDigest: 'sha256:' + 'a'.repeat(64) }] };
else if (op === 'ecs describe-services') {
  const current = state.autoRollback && state.updated === revision(serviceName) ? 'old-task' : (state.updated || 'old-task');
  result = { services: [{ status: 'ACTIVE', desiredCount: state.desiredCount ?? 1, runningCount: state.noRunning ? 0 : (state.desiredCount ?? 1), pendingCount: 0, deploymentController: { type: 'ECS' }, taskDefinition: current, networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet'], securityGroups: ['sg'], assignPublicIp: 'DISABLED' } }, deployments: [{ taskDefinition: current, rolloutState: state.inProgress ? 'IN_PROGRESS' : 'COMPLETED' }] }] };
} else if (op === 'secretsmanager put-secret-value') {
  const content = readFileSync(get('--secret-string').slice(7), 'utf8');
  if (!JSON.parse(content).NODE_ENV) process.exit(9);
  result = { VersionId: 'a'.repeat(32) };
} else if (op === 'ecs register-task-definition') {
  const content = readFileSync(get('--cli-input-json').slice(7), 'utf8');
  if (content.includes('do-not-leak')) process.exit(8);
  result = { taskDefinition: { taskDefinitionArn: revision(serviceName) } };
} else if (op === 'ecs update-service') {
  state.updated = get('--task-definition');
  (state.updates ??= []).push(args);
  if (args.includes('--desired-count')) state.desiredCount = Number(get('--desired-count'));
  changed = true;
} else if (op === 'ecs wait' && args[2] === 'services-stable') {
  if (state.updated === revision(serviceName)) await barrier('deploy');
  log('ecs waiter-complete ' + serviceName);
} else if (op === 'ecs run-task') result = { tasks: [{ taskArn: serviceName + ':smoke-task' }] };
else if (op === 'ecs describe-tasks') result = { tasks: [{ containers: [{ name: 'app', exitCode: state.smokeFailed ? 1 : 0 }] }] };
else if (op === 'ssm put-parameter') {
  state.saved = JSON.parse(get('--value'));
  state.previous = state.saved;
  changed = true;
}
if (changed) writeFileSync(statePath, JSON.stringify(state));
console.log(JSON.stringify(result));
`;

function fixture(t, initial = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wgo-cd-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'states'));
  const names =
    options.services ??
    (options.twoServices ? ['user-service', 'map-service'] : ['user-service']);
  for (const name of ['cd.mjs', 'cd-lib.mjs', 'ci-lib.mjs', 'ci-services.json'])
    copyFileSync(new URL(name, import.meta.url), join(dir, 'scripts', name));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'bin/aws'), fake, { mode: 0o755 });
  writeFileSync(join(dir, 'bin/docker'), fake, { mode: 0o755 });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const servicePath = (name) =>
    `${name.endsWith('gateway') ? 'gateways' : 'services'}/${name}`;
  git('init', '-q');
  git('config', 'user.name', 'CD Test');
  git('config', 'user.email', 'cd@example.invalid');
  for (const name of names) {
    mkdirSync(join(dir, servicePath(name), 'src'), { recursive: true });
    writeFileSync(join(dir, servicePath(name), 'src/main.ts'), 'old');
  }
  git('add', '.');
  git('commit', '-qm', 'initial');
  const previousSha = git('rev-parse', 'HEAD');
  const changed =
    options.files ??
    (options.docsOnly ? ['README.md'] : ['services/user-service/src/main.ts']);
  for (const path of changed) {
    const fullPath = join(dir, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, 'new');
  }
  git('add', '.');
  git('commit', '-qm', 'next');
  const sha = git('rev-parse', 'HEAD');
  const configs = {};
  const runtimes = {};
  const statePath = (name) => join(dir, 'states', name + '.json');
  for (const name of names) {
    const config = structuredClone(task);
    config.ecrRepository = `wgo/${name}`;
    config.ecsService = name;
    config.runtimeSecretArn = `arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:${name}-abcdef`;
    config.taskDefinition.family = name;
    if (options.smoke) config.smokeCommand = ['node', '-e', 'process.exit(0)'];
    if (options.migration) config.migrationCommand = ['node', 'migrate.js'];
    configs[name] = config;
    runtimes[name] = { NODE_ENV: 'production', PASSWORD: 'do-not-leak' };
    const state = {
      ...(name === 'user-service' ? initial : {}),
      ...options.states?.[name],
    };
    if (options.previous)
      state.previous = {
        sha: previousSha,
        image:
          options.previousImage ??
          `${registry}/wgo/${name}@sha256:${'a'.repeat(64)}`,
        taskDefinition: 'old-task',
      };
    writeFileSync(statePath(name), JSON.stringify(state));
  }
  options.configure?.(configs, runtimes);
  writeFileSync(join(dir, 'calls.log'), '');
  const env = {
    ...process.env,
    PATH: `${dir}/bin:${process.env.PATH}`,
    FAKE_STATE_DIR: join(dir, 'states'),
    FAKE_LOG: join(dir, 'calls.log'),
    FAKE_BUILD_BARRIER: options.buildBarrier?.join(',') ?? '',
    FAKE_DEPLOY_BARRIER: options.deployBarrier?.join(',') ?? '',
    CD_SHA: sha,
    AWS_ACCOUNT_ID: '123456789012',
    ECS_CLUSTER: 'cluster',
    ECR_REGISTRY: registry,
    CD_IMAGE_PLATFORM: 'linux/amd64',
    CD_STATE_PREFIX: '/wgo/test',
    CD_SERVICES_JSON: JSON.stringify(configs),
    CD_RUNTIME_SECRETS_JSON: JSON.stringify(runtimes),
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    CD_FORCE_SERVICES: options.force ? 'user-service' : '',
    CD_INITIAL_DEPLOYMENT: options.initial ? 'true' : 'false',
    CD_BUILD_CONCURRENCY: '2',
    CD_DEPLOY_CONCURRENCY: '4',
    ...options.env,
  };
  return {
    dir,
    sha,
    previousSha,
    statePath,
    git,
    execute(mode = 'staging') {
      const result = spawnSync(process.execPath, ['scripts/cd.mjs', mode], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.ok(
        !result.stdout.includes('do-not-leak') &&
          !result.stderr.includes('do-not-leak'),
      );
      return {
        ...result,
        state: JSON.parse(readFileSync(statePath('user-service'), 'utf8')),
        states: Object.fromEntries(
          names.map((name) => [
            name,
            JSON.parse(readFileSync(statePath(name), 'utf8')),
          ]),
        ),
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
    setup.statePath('user-service'),
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
    { initial: true, previous: true },
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

test('selected image builds and independent deployments actually overlap', (t) => {
  const peers = ['user-service', 'map-service'];
  const setup = fixture(
    t,
    {},
    {
      twoServices: true,
      buildBarrier: peers,
      deployBarrier: peers,
      migration: true,
    },
  );
  const result = setup.execute();
  assert.equal(result.status, 0, result.stderr);
  for (const name of peers) {
    assert.ok(
      result.calls.indexOf(`docker build ${name}`) <
        result.calls.indexOf('docker complete'),
    );
    assert.ok(
      result.calls.indexOf(`ecs wait ${name}`) <
        result.calls.indexOf('ecs waiter-complete'),
    );
    assert.equal(result.states[name].saved.sha, setup.sha);
  }
  assert.ok(
    result.calls.lastIndexOf('ecr describe-images') <
      result.calls.indexOf('secretsmanager put-secret-value'),
  );
});

test('only the changed domain deploys and unchanged unhealthy services are not inspected', (t) => {
  const result = fixture(
    t,
    {},
    {
      twoServices: true,
      previous: true,
      states: { 'map-service': { desiredCount: 0, inProgress: true } },
    },
  ).execute();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /docker build user-service/);
  assert.doesNotMatch(
    result.calls,
    /(?:docker build|ecs describe-services|ecs update-service|ssm put-parameter) map-service/,
  );
});

test('documentation and tests alone produce no build or ECS writes', (t) => {
  const result = fixture(
    t,
    {},
    {
      twoServices: true,
      previous: true,
      files: [
        'README.md',
        'services/user-service/test/auth.test.ts',
        'services/map-service/README.md',
      ],
    },
  ).execute();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(
    result.calls,
    /docker build|ecs |secretsmanager |ssm put-parameter/,
  );
});

test('shared runtime changes select every configured service', (t) => {
  const result = fixture(
    t,
    {},
    {
      twoServices: true,
      previous: true,
      files: ['packages/contracts/event.js'],
    },
  ).execute();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /docker build user-service/);
  assert.match(result.calls, /docker build map-service/);
});

test('a failed build drains peers and prevents every deployment and stale release publication', (t) => {
  const peers = ['user-service', 'map-service'];
  const setup = fixture(
    t,
    { buildFailed: true },
    { twoServices: true, buildBarrier: peers },
  );
  writeFileSync(join(setup.dir, 'release.json'), 'stale release');
  const result = setup.execute();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /user-service: docker buildx failed/);
  assert.match(result.calls, /docker complete map-service/);
  assert.doesNotMatch(
    result.calls,
    /secretsmanager |ecs register-task-definition|ecs update-service|ecs run-task|ssm put-parameter/,
  );
  assert.equal(existsSync(join(setup.dir, 'release.json')), false);
});

test('failed rollout rolls back only its owner, drains successful peers, and blocks HTTP', (t) => {
  const peers = ['user-service', 'map-service'];
  const setup = fixture(
    t,
    { smokeFailed: true },
    {
      services: [...peers, 'http-gateway'],
      smoke: true,
      deployBarrier: peers,
    },
  );
  const result = setup.execute();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /user-service:.*smoke failed/);
  assert.equal(result.states['user-service'].updated, 'old-task');
  assert.equal(result.states['user-service'].saved, undefined);
  assert.equal(result.states['map-service'].saved.sha, setup.sha);
  assert.equal(result.states['map-service'].updates.length, 1);
  assert.doesNotMatch(
    result.calls,
    /(?:secretsmanager put-secret-value|ecs update-service) http-gateway/,
  );
  assert.equal(existsSync(join(setup.dir, 'release.json')), false);
});

test('HTTP waits for all selected backends and WS verification', (t) => {
  const setup = fixture(
    t,
    {},
    {
      services: [
        'user-service',
        'map-service',
        'post-service',
        'notification-service',
        'moderation-service',
        'ws-gateway',
        'http-gateway',
      ],
    },
  );
  const result = setup.execute();
  assert.equal(result.status, 0, result.stderr);
  const begin = (name) =>
    result.calls.indexOf(`secretsmanager put-secret-value ${name}`);
  const done = (name) => result.calls.indexOf(`ssm put-parameter ${name}`);
  assert.ok(done('user-service') < begin('post-service'));
  assert.ok(done('map-service') < begin('post-service'));
  assert.ok(done('post-service') < begin('ws-gateway'));
  for (const name of Object.keys(result.states).filter(
    (name) => name !== 'http-gateway',
  ))
    assert.ok(done(name) < begin('http-gateway'));
});

test('retry after partial success deploys only the service without a successful state', (t) => {
  const setup = fixture(
    t,
    {},
    {
      twoServices: true,
      smoke: true,
      states: { 'map-service': { smokeFailed: true } },
    },
  );
  const failed = setup.execute();
  assert.equal(failed.status, 1);
  assert.equal(failed.states['user-service'].saved.sha, setup.sha);
  writeFileSync(
    setup.statePath('map-service'),
    JSON.stringify({ smokeFailed: false }),
  );
  const retried = setup.execute();
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(
    (retried.calls.match(/docker build user-service/g) ?? []).length,
    1,
  );
  assert.equal(
    (retried.calls.match(/docker build map-service/g) ?? []).length,
    2,
  );
  assert.equal(retried.states['map-service'].saved.sha, setup.sha);
});

test('production skips unchanged digest without inspecting unrelated stopped ECS service', (t) => {
  const setup = fixture(
    t,
    { desiredCount: 0 },
    { previous: true, docsOnly: true },
  );
  assert.equal(setup.execute().status, 0);
  const result = setup.execute('production');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /docker build|ecs |ssm put-parameter/);
});

test('invalid concurrency and aliased deployment targets fail before writes', (t) => {
  const invalidLimit = fixture(
    t,
    {},
    { env: { CD_DEPLOY_CONCURRENCY: '0' } },
  ).execute();
  assert.equal(invalidLimit.status, 1);
  assert.equal(invalidLimit.calls, '');
  const duplicate = fixture(
    t,
    {},
    {
      twoServices: true,
      configure(configs) {
        configs['map-service'].ecsService = configs['user-service'].ecsService;
      },
    },
  ).execute();
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /ecsService is shared/);
  assert.doesNotMatch(
    duplicate.calls,
    /docker build|ecs |secretsmanager |ssm put-parameter/,
  );
});
