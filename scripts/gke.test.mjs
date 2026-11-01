import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clusterLocation,
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

const standard = {
  ...config,
  deploymentProfile: 'standard-demo',
  clusterLocation: 'asia-northeast3-a',
  replicas: 1,
};
test('Standard requires a Seoul zone and one replica; legacy Autopilot remains regional', () => {
  assert.equal(
    clusterLocation(validateEnvironment(standard)),
    'asia-northeast3-a',
  );
  assert.equal(clusterLocation(validateEnvironment(config)), config.region);
  for (const patch of [
    { clusterLocation: undefined },
    { clusterLocation: 'asia-northeast3' },
    { clusterLocation: 'us-central1-a' },
    { replicas: 2 },
    { deploymentProfile: 'unknown' },
  ])
    assert.throws(() => validateEnvironment({ ...standard, ...patch }));
});
test('Standard budget covers seven apps plus one migration and overlapping cleanup', () => {
  const pods = applications.map(([name]) =>
    appResources(standard, name, image(name)).find(
      (r) => r.kind === 'Deployment',
    ),
  );
  for (const deployment of pods)
    assert.deepEqual(deployment.spec.strategy.rollingUpdate, {
      maxUnavailable: 1,
      maxSurge: 0,
    });
  const migration = migrationJob(
    standard,
    'user-service',
    image('user-service'),
    'abcde123',
  ).spec.template.spec;
  const cleanup = appResources(
    standard,
    'notification-service',
    image('notification-service'),
  ).find((r) => r.kind === 'CronJob').spec.jobTemplate.spec.template.spec;
  const totals = [
    ...pods.map((d) => d.spec.template.spec),
    migration,
    cleanup,
  ].reduce(
    (sum, pod) => {
      const containers = [
        ...pod.containers,
        ...(pod.initContainers ?? []).filter(
          (c) => c.restartPolicy === 'Always',
        ),
      ];
      for (const c of containers) {
        sum.cpu += parseInt(c.resources.requests.cpu);
        sum.memory += parseInt(c.resources.requests.memory);
        assert.equal(c.resources.requests['ephemeral-storage'], '128Mi');
      }
      return sum;
    },
    { cpu: 0, memory: 0 },
  );
  assert.deepEqual(totals, { cpu: 340, memory: 5888 });
  // Reserve room for the existing system/storage requests after maintenance removal.
  assert.ok(1530 + totals.cpu <= 1930);
  assert.ok(7048 + totals.memory < 13273);
});
test('Services never route application traffic to migrations or cleanup jobs', () => {
  for (const name of ['user-service', 'notification-service']) {
    const items = appResources(standard, name, image(name));
    const selector = items.find((r) => r.kind === 'Service').spec.selector;
    const matches = (labels) =>
      Object.entries(selector).every(([key, value]) => labels[key] === value);
    assert.ok(
      matches(
        items.find((r) => r.kind === 'Deployment').spec.template.metadata
          .labels,
      ),
    );
    assert.equal(
      matches(
        migrationJob(standard, name, image(name), 'abcde123').spec.template
          .metadata.labels,
      ),
      false,
    );
    const cron = items.find((r) => r.kind === 'CronJob');
    if (cron)
      assert.equal(
        matches(cron.spec.jobTemplate.spec.template.metadata.labels),
        false,
      );
  }
});
test('both workflow jobs use resolved location and production requires opt-in', () => {
  const workflow = readFileSync('.github/workflows/cd.yml', 'utf8');
  assert.equal(
    workflow.match(/GKE_LOCATION: \$\{\{ steps.config.outputs.location \}\}/g)
      ?.length,
    2,
  );
  assert.doesNotMatch(workflow, /use_auth_provider: true/);
  assert.equal(
    workflow.match(
      /CLOUDSDK_CONTAINER_USE_APPLICATION_DEFAULT_CREDENTIALS: 'true'/g,
    )?.length,
    2,
  );
  assert.equal(
    workflow.match(/gcloud container clusters get-credentials/g)?.length,
    2,
  );
  assert.match(
    workflow,
    /if: github.event_name == 'push' && vars.CD_ENABLE_PRODUCTION == 'true'/,
  );
});

test('Standard demo renders an explicit localhost HTTP origin for local frontend testing', () => {
  const local = { ...standard, webOrigins: ['http://localhost:5173'] };
  for (const name of ['http-gateway', 'ws-gateway']) {
    const settings = appResources(local, name, image(name)).find(
      (resource) => resource.kind === 'ConfigMap',
    ).data;
    assert.equal(settings.CORS_ORIGINS, 'http://localhost:5173');
    assert.equal(settings.WS_ALLOWED_ORIGINS, 'http://localhost:5173');
  }
});

test('HTTP origins are limited to canonical localhost origins in Standard demo', () => {
  for (const origin of [
    'http://example.com',
    'http://localhost.example.com:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5173/',
    'http://localhost:5173/path',
    'http://localhost:5173?query=1',
    'http://localhost:5173#fragment',
    'http://user:password@localhost:5173',
    '*',
  ]) {
    assert.throws(
      () => validateEnvironment({ ...standard, webOrigins: [origin] }),
      /webOrigins/,
    );
  }
  assert.throws(
    () =>
      validateEnvironment({ ...config, webOrigins: ['http://localhost:5173'] }),
    /webOrigins/,
  );
  assert.throws(
    () => validateEnvironment({ ...standard, webOrigins: [] }),
    /webOrigins/,
  );
  assert.doesNotThrow(() =>
    validateEnvironment({ ...standard, webOrigins: ['https://example.com'] }),
  );
});

test('explicit Autopilot rejects localhost HTTP origins', () => {
  assert.throws(
    () =>
      validateEnvironment({
        ...config,
        deploymentProfile: 'autopilot',
        webOrigins: ['http://localhost:5173'],
      }),
    /webOrigins/,
  );
});
