import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { deploy } from './cd.mjs';
import { releaseResources, resourceHash } from './cd-lib.mjs';
import { applications } from './gke-lib.mjs';
const config = {
  project: 'wgo-test',
  region: 'asia-northeast3',
  cluster: 'wgo-demo',
  namespace: 'wgo-demo',
  registry: 'asia-northeast3-docker.pkg.dev/wgo-test/wgo',
  sqlInstance: 'wgo-test:asia-northeast3:wgo-demo',
  domain: 'api.example.com',
  wsDomain: 'ws.example.com',
  staticIp: 'wgo-demo-ingress',
  secretVersion: '1',
  replicas: 1,
  webOrigins: ['https://demo.example.com'],
};
const oldSha = 'a'.repeat(40),
  sha = 'b'.repeat(40);
const image = (name, digest = 'a') =>
  `${config.registry}/${name}@sha256:${digest.repeat(64)}`;
function harness({
  first = false,
  failure,
  changed = ['services/user-service/src/example.ts'],
  mode = 'staging',
  nextConfig = config,
} = {}) {
  const events = [],
    current = new Map(),
    states = new Map();
  for (const [name] of applications) {
    const resources = releaseResources(config, name, image(name), mode);
    const state = {
      sha: oldSha,
      sourceSha: oldSha,
      image: image(name),
      resources,
      hash: resourceHash(resources),
    };
    if (!first) {
      states.set(name, state);
      current.set(
        name,
        structuredClone(resources.find((r) => r.kind === 'Deployment')),
      );
    }
  }
  let failed = false,
    saved;
  const run = async (exe, args, input) => {
    const operation =
      exe === 'kubectl' && args[0] === '--namespace' ? args.slice(2) : args;
    events.push({
      exe,
      args: operation,
      input: input ? JSON.parse(input) : undefined,
    });
    const [op, kind, name] = operation;
    if (exe === 'kubectl' && op === 'config')
      return `gke_${config.project}_${config.region}_${config.cluster}`;
    if (exe === 'git') {
      if (failure === 'older') throw new Error('older release');
      return '';
    }
    if (exe === 'docker') {
      if (failure === 'build') throw new Error('build failed');
      writeFileSync(
        args[args.indexOf('--metadata-file') + 1],
        JSON.stringify({ 'containerimage.digest': 'sha256:' + 'b'.repeat(64) }),
      );
      return '';
    }
    if (exe === 'curl') {
      if (failure === 'https' && !failed) {
        failed = true;
        throw new Error('https failed');
      }
      return '';
    }
    if (op === 'get' && kind === 'configmap') {
      if (failure === 'denied') throw new Error('permission denied');
      const state = states.get(name.replace('wgo-release-', ''));
      return state
        ? JSON.stringify({ data: { release: JSON.stringify(state) } })
        : '';
    }
    if (op === 'apply') {
      const items = JSON.parse(input).items;
      for (const r of items) {
        if (r.kind === 'Deployment')
          current.set(r.metadata.name, structuredClone(r));
        if (
          r.kind === 'ConfigMap' &&
          r.metadata.name.startsWith('wgo-release-')
        )
          states.set(
            r.metadata.name.replace('wgo-release-', ''),
            JSON.parse(r.data.release),
          );
      }
      if (
        failure === 'state-response-loss' &&
        !failed &&
        items.some(
          (r) =>
            r.kind === 'ConfigMap' &&
            r.metadata.name === 'wgo-release-user-service',
        )
      ) {
        failed = true;
        throw new Error('state write response lost');
      }
      return '';
    }
    if (op === 'wait' && failure === 'migration' && !failed) {
      failed = true;
      throw new Error('migration failed');
    }
    if (
      op === 'rollout' &&
      operation.includes('deployment/user-service') &&
      failure === 'rollout' &&
      !failed
    ) {
      failed = true;
      throw new Error('rollout failed');
    }
    if (op === 'exec' && failure === 'smoke' && !failed) {
      failed = true;
      throw new Error('smoke failed');
    }
    if (op === 'get' && kind === 'deployment') {
      const d = structuredClone(current.get(name));
      d.metadata.generation = 2;
      d.status = {
        observedGeneration: 2,
        updatedReplicas: 1,
        availableReplicas: 1,
      };
      return JSON.stringify(d);
    }
    if (op === 'delete' && kind === 'deployment') current.delete(name);
    if (op === 'delete' && kind === 'configmap')
      states.delete(name.replace('wgo-release-', ''));
    return '';
  };
  const execute = () =>
    deploy({
      mode,
      config: nextConfig,
      env: {
        CD_SHA: sha,
        CD_INITIAL_DEPLOYMENT: String(first),
        CD_BUILD_CONCURRENCY: '2',
        CD_DEPLOY_CONCURRENCY: '2',
      },
      run,
      changes: () => changed,
      saveRelease: (r) => {
        saved = r;
      },
      readRelease: () => ({
        sha,
        services: applications.map(([name]) => ({
          name,
          image: image(name, 'c'),
          sourceSha: sha,
        })),
      }),
    });
  return {
    execute,
    events,
    states,
    current,
    get saved() {
      return saved;
    },
  };
}
test('changed source builds once before migration and only changed deployment updates', async () => {
  const h = harness();
  await h.execute();
  assert.equal(h.events.filter((e) => e.exe === 'docker').length, 1);
  const build = h.events.findIndex((e) => e.exe === 'docker');
  const migration = h.events.findIndex((e) =>
    e.input?.items.some((r) => r.kind === 'Job'),
  );
  const rollout = h.events.findIndex((e) => e.args[0] === 'rollout');
  assert.ok(build < migration && migration < rollout);
  assert.equal(h.states.get('user-service').sha, sha);
  assert.equal(h.states.get('post-service').sha, oldSha);
  assert.equal(h.saved.services.length, 7);
  assert.equal(Object.hasOwn(h.saved.services[0], 'resources'), false);
});
test('pinned secret version changes redeploy using existing image without build', async () => {
  const h = harness({
    changed: [],
    nextConfig: { ...config, secretVersion: '2' },
  });
  await h.execute();
  assert.equal(h.events.filter((e) => e.exe === 'docker').length, 0);
  assert.equal(h.states.get('post-service').image, image('post-service'));
  assert.match(
    h.states
      .get('post-service')
      .resources.find((r) => r.kind === 'SecretProviderClass').spec.parameters
      .secrets,
    /versions\/2/,
  );
});
for (const failure of ['migration', 'rollout', 'smoke', 'state-response-loss'])
  test(`${failure} failure restores old resources and never advances success state`, async () => {
    const h = harness({ failure });
    await assert.rejects(h.execute());
    assert.equal(h.states.get('user-service').sha, oldSha);
    assert.equal(
      h.current.get('user-service').spec.template.spec.containers[0].image,
      image('user-service'),
    );
    assert.equal(h.saved, undefined);
  });
test('bootstrap failure removes new Deployment and does not invent a successful predecessor', async () => {
  const h = harness({ first: true, failure: 'rollout' });
  await assert.rejects(h.execute());
  assert.equal(h.states.has('user-service'), false);
  assert.equal(h.current.has('user-service'), false);
});
for (const failure of ['denied', 'older', 'build'])
  test(`${failure} is a failure before any running workload mutation`, async () => {
    const h = harness({ failure });
    await assert.rejects(h.execute());
    assert.equal(
      h.events.some((e) => e.args[0] === 'apply'),
      false,
    );
  });
test('production promotes exact staging digests without building', async () => {
  const h = harness({ mode: 'production', changed: [] });
  await h.execute();
  assert.equal(
    h.events.some((e) => e.exe === 'docker'),
    false,
  );
  assert.equal(h.states.get('post-service').image, image('post-service', 'c'));
});

test('first deployment builds every immutable image before applying any resource', async () => {
  const h = harness({ first: true });
  await h.execute();
  const builds = h.events
    .map((e, i) => (e.exe === 'docker' ? i : -1))
    .filter((i) => i >= 0);
  const firstApply = h.events.findIndex((e) => e.args[0] === 'apply');
  assert.equal(builds.length, 7);
  assert.ok(builds.every((i) => i < firstApply));
  const jobEvent = h.events.find((e) =>
    e.input?.items.some((r) => r.kind === 'Job'),
  );
  const job = jobEvent.input.items.find((r) => r.kind === 'Job');
  const deployment = h.states
    .get('user-service')
    .resources.find((r) => r.kind === 'Deployment');
  assert.deepEqual(
    job.spec.template.spec.volumes,
    deployment.spec.template.spec.volumes,
  );
  assert.deepEqual(
    job.spec.template.spec.containers[0].envFrom,
    deployment.spec.template.spec.containers[0].envFrom,
  );
});

test('manifest plus service README does not rebuild an unchanged image', async () => {
  const h = harness({
    changed: ['deploy/gke/runtime.cjs', 'services/user-service/README.md'],
  });
  await h.execute();
  assert.equal(
    h.events.some((e) => e.exe === 'docker'),
    false,
  );
});
