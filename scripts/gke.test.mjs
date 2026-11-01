import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applications,
  appResources,
  foundation,
  migrationJob,
  validateEnvironment,
} from './gke-lib.mjs';
const config = JSON.parse(readFileSync('deploy/gke/environment.example.json'));
const image = (name) => `${config.registry}/${name}@sha256:${'a'.repeat(64)}`;
test('all seven apps have independent immutable Deployments and internal Services', () => {
  assert.equal(applications.length, 7);
  for (const [name] of applications) {
    const items = appResources(config, name, image(name));
    const deployment = items.find((r) => r.kind === 'Deployment');
    assert.equal(
      deployment.spec.template.spec.containers[0].image,
      image(name),
    );
    assert.equal(
      items.find((r) => r.kind === 'Service').spec.type,
      'ClusterIP',
    );
    assert.equal(deployment.spec.template.spec.serviceAccountName, name);
    assert.equal(
      deployment.spec.template.spec.containers[0].readinessProbe.httpGet.path,
      '/health/ready',
    );
    const secret = items.find((r) => r.kind === 'SecretProviderClass');
    assert.match(secret.spec.parameters.secrets, /versions\/1/);
    assert.doesNotMatch(JSON.stringify(items), /PRIVATE KEY|AWS_|latest/);
  }
});
test('only two Gateway domains are public and have HTTPS redirect', () => {
  const items = foundation(config);
  const ingress = items.find((r) => r.kind === 'Ingress');
  assert.deepEqual(
    ingress.spec.rules.map((r) => r.http.paths[0].backend.service.name),
    ['http-gateway', 'ws-gateway'],
  );
  assert.equal(
    items.find((r) => r.kind === 'FrontendConfig').spec.redirectToHttps.enabled,
    true,
  );
});
test('SQL jobs use native sidecars so completion does not wait forever for proxy', () => {
  for (const name of ['user-service', 'notification-service']) {
    const job = migrationJob(config, name, image(name), 'abcde123');
    assert.equal(
      job.spec.template.spec.initContainers[0].restartPolicy,
      'Always',
    );
    assert.equal(job.spec.template.spec.restartPolicy, 'Never');
    assert.equal(job.spec.backoffLimit, 0);
    assert.equal(
      job.spec.template.spec.containers[0].readinessProbe,
      undefined,
    );
  }
});
test('Post trusts both ECK and Redis CA without private server certificates', () => {
  const pod = appResources(config, 'post-service', image('post-service')).find(
    (r) => r.kind === 'Deployment',
  ).spec.template.spec;
  const init = pod.initContainers.find((c) => c.name === 'combine-trust');
  assert.match(init.command[2], /redis-ca.pem/);
  assert.match(init.command[2], /tls.crt/);
  assert.equal(
    pod.volumes.find((v) => v.name === 'certs').secret.secretName,
    'wgo-storage-tls',
  );
});
test('reject mutable images, secret versions and wrong project', () => {
  assert.throws(() =>
    validateEnvironment({ ...config, secretVersion: 'latest' }),
  );
  assert.throws(() =>
    validateEnvironment({ ...config, registry: 'elsewhere' }),
  );
  assert.throws(() => appResources(config, 'user-service', 'image:latest'));
});

test('Notification expiry schedule uses the same native proxy and does not overlap', () => {
  const cron = appResources(
    config,
    'notification-service',
    image('notification-service'),
  ).find((r) => r.kind === 'CronJob');
  assert.equal(cron.spec.concurrencyPolicy, 'Forbid');
  assert.equal(
    cron.spec.jobTemplate.spec.template.spec.initContainers[0].restartPolicy,
    'Always',
  );
  assert.equal(
    cron.spec.jobTemplate.spec.template.spec.containers[0].command.at(-1),
    'dist/persistence/cleanup.js',
  );
});
test('secret version rotation targets only the named service', () => {
  const rotated = { ...config, secretVersions: { 'user-service': '2' } };
  const version = (name) =>
    appResources(rotated, name, image(name)).find(
      (r) => r.kind === 'SecretProviderClass',
    ).spec.parameters.secrets;
  assert.match(version('user-service'), /versions\/2/);
  assert.match(version('post-service'), /versions\/1/);
});
