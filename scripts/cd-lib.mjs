import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appResources, applications } from './gke-lib.mjs';

export function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} is required`);
  return value;
}

const deploymentDependencies = {
  'user-service': [],
  'map-service': [],
  'notification-service': [],
  'moderation-service': [],
  'post-service': ['user-service', 'map-service'],
  'ws-gateway': ['user-service', 'post-service'],
  'http-gateway': [
    'user-service',
    'map-service',
    'post-service',
    'notification-service',
    'moderation-service',
    'ws-gateway',
  ],
};

export function deploymentWaves(services) {
  const remaining = new Map(services.map((service) => [service.name, service]));
  const waves = [];
  while (remaining.size) {
    const wave = [...remaining.values()].filter(({ name }) => {
      const dependencies = deploymentDependencies[name];
      if (!dependencies) throw new Error(`Unknown deployment service: ${name}`);
      return dependencies.every((dependency) => !remaining.has(dependency));
    });
    if (!wave.length) throw new Error('Cyclic deployment dependencies');
    waves.push(wave);
    for (const service of wave) remaining.delete(service.name);
  }
  return waves;
}

export function concurrencyLimit(value, fallback, name) {
  const input = value ?? String(fallback);
  if (!/^[1-7]$/.test(input))
    throw new Error(`${name} must be an integer from 1 to 7`);
  return Number(input);
}

export async function mapConcurrent(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('Concurrency must be a positive integer');
  const results = new Array(items.length);
  const errors = [];
  let next = 0;
  async function consume() {
    while (!errors.length && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        errors.push(
          new Error(
            items[index]?.name
              ? `${items[index].name}: ${error.message}`
              : error.message,
          ),
        );
      }
    }
  }
  // Drain started operations, including rollbacks, before the caller cleans up their input files.
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, consume),
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      errors.map((error) => error.message).join('; '),
    );
  return results;
}

export function validateRelease(release, sha, registry) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    release?.sha !== sha ||
    !Array.isArray(release.services)
  )
    throw new Error('Invalid release manifest');
  const known = new Set(applications.map(([name]) => name));
  const seen = new Set();
  for (const entry of release.services) {
    if (
      !entry ||
      !known.has(entry.name) ||
      seen.has(entry.name) ||
      !/^[a-f0-9]{40}$/.test(entry.sourceSha) ||
      !validImage(entry.image, registry, entry.name)
    )
      throw new Error('Invalid release entry');
    seen.add(entry.name);
  }
  if (seen.size !== known.size)
    throw new Error('Release must contain all seven applications');
  return release;
}

export function validImage(image, registry, name) {
  return (
    typeof image === 'string' &&
    image.startsWith(`${registry}/${name}@sha256:`) &&
    /@sha256:[a-f0-9]{64}$/.test(image)
  );
}

export function deploymentRuntimeChanged(_name, files) {
  return files.some((file) =>
    /^(deploy\/gke\/|scripts\/(?:gke|cd)[^/]*\.mjs$|\.github\/workflows\/cd\.yml$)/.test(
      file,
    ),
  );
}

export function releaseResources(config, name, image, mode) {
  if (!['staging', 'production'].includes(mode))
    throw new Error('Invalid release environment');
  const resources = appResources(config, name, image);
  const settings = resources.find((r) => r.kind === 'ConfigMap');
  settings.data.DEPLOYMENT_ENV = mode;
  if (name === 'http-gateway')
    settings.data.DOCS_ENABLED = String(mode === 'staging');
  const bootstrap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'wgo-bootstrap', namespace: config.namespace },
    data: {
      'runtime.cjs': readFileSync(
        new URL('../deploy/gke/runtime.cjs', import.meta.url),
        'utf8',
      ),
    },
  };
  resources.push(bootstrap);
  // Existing replicas and rollback must keep their original configuration and mounted secret version.
  const names = new Map();
  for (const resource of resources) {
    if (!['ConfigMap', 'SecretProviderClass'].includes(resource.kind)) continue;
    const original = resource.metadata.name;
    const hash = createHash('sha256')
      .update(JSON.stringify(resource))
      .digest('hex')
      .slice(0, 12);
    resource.metadata.name = `${original}-${hash}`;
    if (resource.kind === 'ConfigMap') resource.immutable = true;
    names.set(original, resource.metadata.name);
  }
  const deployment = resources.find((r) => r.kind === 'Deployment');
  const pods = [
    deployment.spec.template.spec,
    ...resources
      .filter((r) => r.kind === 'CronJob')
      .map((r) => r.spec.jobTemplate.spec.template.spec),
  ];
  for (const pod of pods) {
    for (const container of [...pod.containers, ...(pod.initContainers ?? [])])
      for (const entry of container.envFrom ?? [])
        if (entry.configMapRef && names.has(entry.configMapRef.name))
          entry.configMapRef.name = names.get(entry.configMapRef.name);
    for (const volume of pod.volumes) {
      if (volume.configMap && names.has(volume.configMap.name))
        volume.configMap.name = names.get(volume.configMap.name);
      if (volume.csi?.volumeAttributes?.secretProviderClass)
        volume.csi.volumeAttributes.secretProviderClass = names.get(
          volume.csi.volumeAttributes.secretProviderClass,
        );
    }
  }
  return resources;
}

export function resourceHash(resources) {
  return createHash('sha256').update(JSON.stringify(resources)).digest('hex');
}

export function validateState(state, config, name) {
  if (
    !state ||
    !/^[a-f0-9]{40}$/.test(state.sha) ||
    !/^[a-f0-9]{40}$/.test(state.sourceSha) ||
    !validImage(state.image, config.registry, name) ||
    !Array.isArray(state.resources) ||
    state.hash !== resourceHash(state.resources)
  )
    throw new Error(`Invalid ${name} deployment state`);
  const allowed = new Set([
    'ServiceAccount',
    'SecretProviderClass',
    'ConfigMap',
    'Deployment',
    'Service',
    'CronJob',
  ]);
  for (const resource of state.resources) {
    if (
      !allowed.has(resource.kind) ||
      resource.metadata?.namespace !== config.namespace ||
      !(
        resource.metadata.name === name ||
        resource.metadata.name.startsWith(`${name}-`) ||
        resource.metadata.name.startsWith('wgo-bootstrap-')
      )
    )
      throw new Error('Unexpected rollback resource');
  }
  const deployment = state.resources.filter((r) => r.kind === 'Deployment');
  if (
    deployment.length !== 1 ||
    deployment[0].spec.template.spec.containers.find((c) => c.name === 'app')
      ?.image !== state.image
  )
    throw new Error('Deployment state image mismatch');
  return state;
}
