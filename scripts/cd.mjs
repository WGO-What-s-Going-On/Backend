import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { changedFiles, selectChanges, services } from './ci-lib.mjs';
import { readEnvironment, migrationJob, clusterLocation } from './gke-lib.mjs';
import {
  required,
  concurrencyLimit,
  mapConcurrent,
  deploymentWaves,
  validateRelease,
  validateState,
  releaseResources,
  resourceHash,
  validImage,
  deploymentRuntimeChanged,
} from './cd-lib.mjs';

export async function command(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) child.kill();
      else output.push(chunk);
    });
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
    child.once('close', () => clearTimeout(timeout));
    child.on('error', () => reject(new Error(`${executable} failed to start`)));
    child.on('close', (code) =>
      code === 0 && size <= 16 * 1024 * 1024
        ? resolve(Buffer.concat(output).toString('utf8').trim())
        : reject(
            new Error(
              `${executable} ${args[0]} failed; inspect redacted service diagnostics`,
            ),
          ),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function deploy({
  mode,
  env = process.env,
  run = command,
  config = readEnvironment(required(env, 'GCP_ENV_FILE')),
  changes = changedFiles,
  readRelease = () => JSON.parse(readFileSync('release.json', 'utf8')),
  saveRelease = (release) =>
    writeFileSync('release.json', JSON.stringify(release), { mode: 0o600 }),
}) {
  if (!['staging', 'production'].includes(mode))
    throw new Error('Usage: node scripts/cd.mjs staging|production');
  const sha = required(env, 'CD_SHA');
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error('CD_SHA must be a full commit SHA');
  const buildLimit = concurrencyLimit(
    env.CD_BUILD_CONCURRENCY,
    2,
    'CD_BUILD_CONCURRENCY',
  );
  const deployLimit = concurrencyLimit(
    env.CD_DEPLOY_CONCURRENCY,
    4,
    'CD_DEPLOY_CONCURRENCY',
  );
  const platform = env.CD_IMAGE_PLATFORM ?? 'linux/amd64';
  if (platform !== 'linux/amd64')
    throw new Error('GKE demo images and ONNX require linux/amd64');
  if (!['true', 'false'].includes(env.CD_INITIAL_DEPLOYMENT ?? 'false'))
    throw new Error('Invalid CD_INITIAL_DEPLOYMENT');
  const initial = env.CD_INITIAL_DEPLOYMENT === 'true';
  if (initial && mode !== 'staging')
    throw new Error('Only staging can bootstrap');
  const force = (env.CD_FORCE_SERVICES ?? '').split(',').filter(Boolean);
  if (
    force.some(
      (name) => name !== 'all' && !services.some((s) => s.name === name),
    )
  )
    throw new Error('Unknown forced service');
  const context = await run('kubectl', ['config', 'current-context']);
  if (
    context !==
    `gke_${config.project}_${clusterLocation(config)}_${config.cluster}`
  )
    throw new Error('Unexpected Kubernetes context');
  const kube = async (...args) =>
    run('kubectl', ['--namespace', config.namespace, ...args]);
  const apply = async (resources) =>
    run(
      'kubectl',
      ['--namespace', config.namespace, 'apply', '-f', '-'],
      JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources }),
    );
  const promoted =
    mode === 'production'
      ? validateRelease(readRelease(), sha, config.registry)
      : null;
  const scratch = mkdtempSync(join(tmpdir(), 'wgo-gcp-cd-'));
  const prepared = [];
  try {
    for (const service of services) {
      const { name } = service;
      // --ignore-not-found distinguishes absent state from authentication and connectivity failures.
      const raw = await kube(
        'get',
        'configmap',
        `wgo-release-${name}`,
        '--ignore-not-found',
        '-o',
        'json',
      );
      const previous = raw
        ? validateState(JSON.parse(JSON.parse(raw).data.release), config, name)
        : null;
      if (previous)
        await run('git', ['merge-base', '--is-ancestor', previous.sha, sha]);
      if (!previous && !initial && mode === 'staging')
        throw new Error(
          `${name}: initial deployment requires explicit staging bootstrap`,
        );
      const files = previous ? changes(previous.sha, sha) : [];
      const codeChanged =
        !previous ||
        selectChanges(files).matrix.include.some(
          (s) => s.name === name && s.build_image,
        );
      const promotion = promoted?.services.find((entry) => entry.name === name);
      let image = promotion?.image ?? previous?.image;
      let sourceSha = promotion?.sourceSha ?? previous?.sourceSha ?? sha;
      if (promotion)
        await run('git', ['merge-base', '--is-ancestor', sourceSha, sha]);
      const build = mode === 'staging' && codeChanged;
      const resources = image
        ? releaseResources(config, name, image, mode)
        : null;
      const changed =
        build ||
        !previous ||
        previous.image !== image ||
        previous.hash !== resourceHash(resources) ||
        deploymentRuntimeChanged(name, files) ||
        force.includes('all') ||
        force.includes(name);
      prepared.push({ ...service, previous, image, sourceSha, build, changed });
    }
    // Finish all image builds before the first schema or running workload changes.
    await mapConcurrent(
      prepared.filter((s) => s.build),
      buildLimit,
      async (service) => {
        const tag = `${config.registry}/${service.name}:${sha}`;
        const metadata = join(scratch, `${service.name}.json`);
        await run('docker', [
          'buildx',
          'build',
          '--platform',
          platform,
          '--push',
          '--tag',
          tag,
          '--metadata-file',
          metadata,
          service.path,
        ]);
        const digest = JSON.parse(readFileSync(metadata, 'utf8'))[
          'containerimage.digest'
        ];
        const image = `${config.registry}/${service.name}@${digest}`;
        if (!validImage(image, config.registry, service.name))
          throw new Error('Build returned invalid digest');
        service.image = image;
        service.sourceSha = sha;
      },
    );
    for (const wave of deploymentWaves(prepared.filter((s) => s.changed))) {
      await mapConcurrent(wave, deployLimit, async (service) => {
        const { name, previous, image, sourceSha } = service;
        const resources = releaseResources(config, name, image, mode);
        const deployment = resources.find((r) => r.kind === 'Deployment');
        let jobName;
        try {
          await apply(
            resources.filter(
              (r) => !['Deployment', 'Service', 'CronJob'].includes(r.kind),
            ),
          );
          if (['user-service', 'notification-service'].includes(name)) {
            const job = migrationJob(
              config,
              name,
              image,
              `${sha.slice(0, 12)}${randomBytes(4).toString('hex')}`,
            );
            // Jobs use exactly the same pinned secret/config/bootstrap as the application.
            const appPod = deployment.spec.template.spec;
            job.spec.template.spec.volumes = structuredClone(appPod.volumes);
            job.spec.template.spec.containers[0].envFrom = structuredClone(
              appPod.containers[0].envFrom,
            );
            jobName = job.metadata.name;
            await apply([job]);
            await kube(
              'wait',
              '--for=condition=complete',
              `job/${jobName}`,
              '--timeout=330s',
            );
          }
          await apply(
            resources.filter((r) =>
              ['Deployment', 'Service', 'CronJob'].includes(r.kind),
            ),
          );
          await kube(
            'rollout',
            'status',
            `deployment/${name}`,
            '--timeout=600s',
          );
          const ready = JSON.parse(
            await kube('get', 'deployment', name, '-o', 'json'),
          );
          if (
            ready.spec.template.spec.containers.find((c) => c.name === 'app')
              ?.image !== image ||
            ready.status?.observedGeneration < ready.metadata.generation ||
            ready.status?.updatedReplicas !== ready.spec.replicas ||
            ready.status?.availableReplicas !== ready.spec.replicas
          )
            throw new Error(`${name}: target revision is not available`);
          // Smoke each backend from inside its Pod; ingress TLS is verified after the gateway wave.
          const port = deployment.spec.template.spec.containers[0].ports.find(
            (p) => p.name === 'http',
          ).containerPort;
          await kube(
            'exec',
            `deployment/${name}`,
            '-c',
            'app',
            '--',
            'node',
            '-e',
            `fetch('http://127.0.0.1:${port}/health/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))`,
          );
          if (name === 'http-gateway' || name === 'ws-gateway')
            await run('curl', [
              '--fail',
              '--silent',
              '--show-error',
              '--max-time',
              '15',
              `https://${name === 'http-gateway' ? config.domain : config.wsDomain}/health/ready`,
            ]);
          const state = {
            sha,
            sourceSha,
            image,
            hash: resourceHash(resources),
            resources,
          };
          await apply([
            {
              apiVersion: 'v1',
              kind: 'ConfigMap',
              metadata: {
                name: `wgo-release-${name}`,
                namespace: config.namespace,
              },
              data: { release: JSON.stringify(state) },
            },
          ]);
          console.log(`${name}: ${mode} release verified`);
        } catch (error) {
          const failures = [error];
          if (jobName) {
            try {
              await kube(
                'delete',
                'job',
                jobName,
                '--ignore-not-found',
                '--wait=true',
              );
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
          }
          try {
            if (previous) {
              await apply(previous.resources);
              await kube(
                'rollout',
                'status',
                `deployment/${name}`,
                '--timeout=600s',
              );
              // A successful state write can lose its response. Restore the record with the workload.
              await apply([
                {
                  apiVersion: 'v1',
                  kind: 'ConfigMap',
                  metadata: {
                    name: `wgo-release-${name}`,
                    namespace: config.namespace,
                  },
                  data: { release: JSON.stringify(previous) },
                },
              ]);
            } else {
              if (name === 'notification-service')
                await kube(
                  'delete',
                  'cronjob',
                  'notification-service-expiry',
                  '--ignore-not-found',
                );
              await kube(
                'delete',
                'deployment',
                name,
                '--ignore-not-found',
                '--wait=true',
              );
              await kube(
                'delete',
                'configmap',
                `wgo-release-${name}`,
                '--ignore-not-found',
              );
            }
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
          throw new AggregateError(
            failures,
            failures.map((f) => f.message).join('; '),
          );
        }
      });
    }
    const release = {
      sha,
      services: prepared.map(({ name, image, sourceSha }) => ({
        name,
        image,
        sourceSha,
      })),
    };
    validateRelease(release, sha, config.registry);
    if (mode === 'staging') saveRelease(release);
    return release;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await deploy({ mode: process.argv[2] });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
