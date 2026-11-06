import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRelease,
  releaseResources,
  resourceHash,
  validateState,
  concurrencyLimit,
  mapConcurrent,
  deploymentWaves,
  deploymentRuntimeChanged,
} from './cd-lib.mjs';
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
const sha = 'a'.repeat(40);
const image = (name) => `${config.registry}/${name}@sha256:${'b'.repeat(64)}`;
const release = () => ({
  sha,
  services: applications.map(([name]) => ({
    name,
    image: image(name),
    sourceSha: sha,
  })),
});

test('promotion requires exactly seven unique immutable images from allowed registry', () => {
  assert.deepEqual(validateRelease(release(), sha, config.registry), release());
  for (const alter of [
    (r) => r.services.pop(),
    (r) => r.services.push(r.services[0]),
    (r) => (r.services[0].image = 'evil/image@sha256:' + 'b'.repeat(64)),
    (r) => (r.services[0].sourceSha = 'not-sha'),
    (r) => (r.sha = 'c'.repeat(40)),
  ]) {
    const invalid = release();
    alter(invalid);
    assert.throws(() => validateRelease(invalid, sha, config.registry));
  }
});
test('settings, secret refs and bootstrap names are pinned and restoration keeps old versions', () => {
  const old = releaseResources(
    config,
    'user-service',
    image('user-service'),
    'staging',
  );
  const next = releaseResources(
    { ...config, secretVersion: '2' },
    'user-service',
    image('user-service'),
    'staging',
  );
  const provider = (list) => list.find((r) => r.kind === 'SecretProviderClass');
  assert.notEqual(provider(old).metadata.name, provider(next).metadata.name);
  assert.match(provider(old).spec.parameters.secrets, /versions\/1/);
  assert.match(provider(next).spec.parameters.secrets, /versions\/2/);
  for (const list of [old, next]) {
    const pod = list.find((r) => r.kind === 'Deployment').spec.template.spec;
    for (const volume of pod.volumes)
      if (volume.configMap)
        assert.ok(
          list.some(
            (r) =>
              r.kind === 'ConfigMap' &&
              r.metadata.name === volume.configMap.name,
          ),
        );
    const ref = pod.volumes.find((v) => v.csi).csi.volumeAttributes
      .secretProviderClass;
    assert.equal(ref, provider(list).metadata.name);
  }
  assert.notEqual(resourceHash(old), resourceHash(next));
});
test('notification uses the internal User block endpoint from its ConfigMap', () => {
  const resources = releaseResources(
    config,
    'notification-service',
    image('notification-service'),
    'staging',
  );
  const container = resources.find((r) => r.kind === 'Deployment').spec.template
    .spec.containers[0];
  const settings = resources.find(
    (r) =>
      r.kind === 'ConfigMap' &&
      r.metadata.name === container.envFrom[0].configMapRef.name,
  ).data;
  assert.equal(
    settings.NOTIFICATION_USER_BLOCKS_URL,
    'http://user-service:3001/internal/notifications/blocks/check',
  );
  assert.equal(settings.NOTIFICATION_SERVICE_PRIVATE_JWK, undefined);
});
test('rollback rejects resource injection and inconsistent state digest', () => {
  const resources = releaseResources(
    config,
    'user-service',
    image('user-service'),
    'staging',
  );
  const state = {
    sha,
    sourceSha: sha,
    image: image('user-service'),
    resources,
    hash: resourceHash(resources),
  };
  assert.equal(validateState(state, config, 'user-service'), state);
  const invalid = structuredClone(state);
  invalid.resources[0].metadata.namespace = 'other';
  invalid.hash = resourceHash(invalid.resources);
  assert.throws(() => validateState(invalid, config, 'user-service'));
  assert.throws(() =>
    validateState({ ...state, hash: 'bad' }, config, 'user-service'),
  );
});
test('dependency waves deploy backend before gateways regardless of manifest order', () => {
  assert.deepEqual(
    deploymentWaves(applications.map(([name]) => ({ name }))).map((w) =>
      w.map((s) => s.name).sort(),
    ),
    [
      [
        'map-service',
        'moderation-service',
        'notification-service',
        'user-service',
      ],
      ['post-service'],
      ['ws-gateway'],
      ['http-gateway'],
    ],
  );
});
test('parallel operations drain already started work after failure', async () => {
  const completed = [];
  await assert.rejects(
    mapConcurrent([1, 2, 3], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 1 : 20));
      completed.push(value);
      if (value === 1) throw new Error('failed');
    }),
  );
  assert.deepEqual(completed.sort(), [1, 2]);
  assert.equal(concurrencyLimit('7', 2, 'limit'), 7);
  for (const value of ['0', '8', '1.5', 'x'])
    assert.throws(() => concurrencyLimit(value, 2, 'limit'));
});
test('deployment code changes redeploy without forcing application rebuild', () => {
  assert.equal(
    deploymentRuntimeChanged('user-service', ['deploy/gke/runtime.cjs']),
    true,
  );
  assert.equal(
    deploymentRuntimeChanged('user-service', ['scripts/gke-lib.mjs']),
    true,
  );
  assert.equal(
    deploymentRuntimeChanged('user-service', ['docs/deployment/gcp.md']),
    false,
  );
});
