import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { changedFiles, selectChanges } from './ci-lib.mjs';
import {
  required,
  parseSecretJson,
  validateService,
  renderTask,
  selectReleaseServices,
  validateRelease,
} from './cd-lib.mjs';

const mode = process.argv[2];
const env = process.env;
const sha = required(env, 'CD_SHA');
if (!/^[a-f0-9]{40}$/.test(sha))
  throw new Error('CD_SHA must be a full commit SHA');
const scratch = mkdtempSync(join(tmpdir(), 'wgo-cd-'));
const file = (name, value) => {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  // CLI errors can echo task definitions or secret JSON: never print raw stdout/stderr on failure.
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args[0] ?? ''} failed (details withheld to protect configuration)`,
    );
  return result.stdout?.trim() ?? '';
}
function aws(...args) {
  return JSON.parse(
    run('aws', [...args, '--output', 'json', '--no-cli-pager']) || '{}',
  );
}
function sameOrNewer(previous) {
  if (!previous) return;
  if (!/^[a-f0-9]{40}$/.test(previous.sha))
    throw new Error('Invalid deployment state SHA');
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', previous.sha, sha])
      .status !== 0
  )
    throw new Error(
      'Refusing an older/divergent release; use an explicit recovery procedure',
    );
}
async function deploy() {
  if (!['staging', 'production'].includes(mode))
    throw new Error('Usage: node scripts/cd.mjs staging|production');
  const initialDeployment = env.CD_INITIAL_DEPLOYMENT === 'true';
  if (!['true', 'false'].includes(env.CD_INITIAL_DEPLOYMENT ?? 'false'))
    throw new Error('CD_INITIAL_DEPLOYMENT must be true or false');
  if (initialDeployment && mode !== 'staging')
    throw new Error('Initial deployment is only supported for staging');
  const account = required(env, 'AWS_ACCOUNT_ID');
  if (
    !/^\d{12}$/.test(account) ||
    aws('sts', 'get-caller-identity').Account !== account
  )
    throw new Error('AWS role resolved to an unexpected account');
  const cluster = required(env, 'ECS_CLUSTER');
  const registry = required(env, 'ECR_REGISTRY');
  if (!/^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(registry))
    throw new Error('Invalid ECR_REGISTRY');
  const platform = required(env, 'CD_IMAGE_PLATFORM');
  if (!['linux/amd64', 'linux/arm64'].includes(platform))
    throw new Error('CD_IMAGE_PLATFORM must be linux/amd64 or linux/arm64');
  const prefix = required(env, 'CD_STATE_PREFIX');
  if (!/^\/[a-zA-Z0-9_.\/-]+$/.test(prefix))
    throw new Error('Invalid CD_STATE_PREFIX');
  const configured = parseSecretJson(
    required(env, 'CD_SERVICES_JSON'),
    'CD_SERVICES_JSON',
  );
  const runtime = parseSecretJson(
    required(env, 'CD_RUNTIME_SECRETS_JSON'),
    'CD_RUNTIME_SECRETS_JSON',
  );
  const manifest = JSON.parse(readFileSync('scripts/ci-services.json', 'utf8'));
  const services = selectReleaseServices(manifest, configured);
  if (!services.length)
    throw new Error('At least one service must be configured');
  const forced = (env.CD_FORCE_SERVICES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    forced.some(
      (name) =>
        name !== 'all' && !services.some((service) => service.name === name),
    )
  )
    throw new Error('Unknown force service');
  for (const service of services)
    validateService(service.name, configured[service.name], platform);
  const statePath = (name) => `${prefix.replace(/\/$/, '')}/${mode}/${name}`;
  function state(name) {
    // GetParameters reports missing names separately; IAM/network errors never become first deployments.
    const result = aws('ssm', 'get-parameters', '--names', statePath(name));
    const record = result.Parameters?.[0];
    return record ? parseSecretJson(record.Value, 'deployment state') : null;
  }
  let release = { sha, services: [] };
  if (mode === 'production')
    release = validateRelease(
      JSON.parse(readFileSync('release.json', 'utf8')),
      sha,
    );
  if (
    mode === 'production' &&
    (release.services.length !== services.length ||
      services.some(
        (service) =>
          !release.services.some((entry) => entry.name === service.name),
      ))
  )
    throw new Error('Staging/production configured service sets must match');
  const prepared = [];
  for (const service of services) {
    const name = service.name;
    const config = configured[name];
    const previous = state(name);
    sameOrNewer(previous);
    const existing = aws(
      'ecs',
      'describe-services',
      '--cluster',
      cluster,
      '--services',
      config.ecsService,
    ).services?.[0];
    const bootstrap =
      initialDeployment && !previous && existing?.desiredCount === 0;
    if (
      !existing ||
      existing.status !== 'ACTIVE' ||
      existing.deploymentController?.type !== 'ECS' ||
      !Number.isInteger(existing.desiredCount) ||
      (existing.desiredCount < 1 && !bootstrap)
    )
      throw new Error(
        `${name}: active ECS rolling service required; zero count requires staging initial deployment and no successful state`,
      );
    if (
      existing.deployments?.some(
        (deployment) => deployment.rolloutState === 'IN_PROGRESS',
      )
    )
      throw new Error(`${name}: another deployment is still in progress`);
    const force = forced.includes('all') || forced.includes(name);
    let image;
    let sourceSha = sha;
    if (mode === 'staging') {
      const changed =
        !previous ||
        selectChanges(
          changedFiles(previous.sha, sha),
        ).deploy_matrix.include.some((entry) => entry.name === name);
      if (!changed && !force) {
        release.services.push({
          name,
          image: previous.image,
          sourceSha: previous.sha,
        });
        console.log(
          `${name}: no runtime change since last successful staging deployment`,
        );
        continue;
      }
      const tag = `${sha}-${required(env, 'GITHUB_RUN_ID')}-${required(env, 'GITHUB_RUN_ATTEMPT')}`;
      const tagImage = `${registry}/${config.ecrRepository}:${tag}`;
      run(
        'docker',
        [
          'buildx',
          'build',
          '--platform',
          platform,
          '--provenance=false',
          '--label',
          `org.opencontainers.image.revision=${sha}`,
          '--tag',
          tagImage,
          '--push',
          service.path,
        ],
        { stdio: 'inherit' },
      );
      const result = aws(
        'ecr',
        'describe-images',
        '--repository-name',
        config.ecrRepository,
        '--image-ids',
        `imageTag=${tag}`,
      );
      const digest = result.imageDetails?.[0]?.imageDigest;
      if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ''))
        throw new Error(`${name}: no immutable image digest`);
      image = `${registry}/${config.ecrRepository}@${digest}`;
    } else {
      const entry = release.services.find((entry) => entry.name === name);
      image = entry.image;
      sourceSha = entry.sourceSha;
      if (!image.startsWith(`${registry}/${config.ecrRepository}@sha256:`))
        throw new Error(
          `${name}: release image does not match configured repository`,
        );
      if (previous?.image === image && !force) {
        console.log(`${name}: production already uses the staged image`);
        continue;
      }
    }
    prepared.push({ name, config, existing, bootstrap, image, sourceSha });
  }
  // Complete every image push before starting migrations or updating a running service.
  for (const {
    name,
    config,
    existing,
    bootstrap,
    image,
    sourceSha,
  } of prepared) {
    const secretValues = runtime[name];
    // Validate before changing AWS secret versions. Task rendering is repeated with the real version below.
    renderTask(config, image, secretValues, randomUUID());
    const secret = aws(
      'secretsmanager',
      'put-secret-value',
      '--secret-id',
      config.runtimeSecretArn,
      '--secret-string',
      `file://${file(`${name}-secret.json`, secretValues)}`,
      '--client-request-token',
      randomUUID(),
    );
    const task = renderTask(config, image, secretValues, secret.VersionId);
    const revision = aws(
      'ecs',
      'register-task-definition',
      '--cli-input-json',
      `file://${file(`${name}-task.json`, task)}`,
    ).taskDefinition?.taskDefinitionArn;
    if (!revision)
      throw new Error(`${name}: task definition registration failed`);
    async function oneOff(command, purpose) {
      const input = {
        cluster,
        taskDefinition: revision,
        launchType: 'FARGATE',
        platformVersion: existing.platformVersion ?? 'LATEST',
        count: 1,
        networkConfiguration: existing.networkConfiguration,
        overrides: {
          containerOverrides: [{ name: config.containerName, command }],
        },
        startedBy: `wgo-${purpose}`,
      };
      const result = aws(
        'ecs',
        'run-task',
        '--cli-input-json',
        `file://${file(`${name}-${purpose}.json`, input)}`,
      );
      const arn = result.tasks?.[0]?.taskArn;
      if (!arn || result.failures?.length)
        throw new Error(`${name}: ${purpose} task failed to start`);
      try {
        run('aws', [
          'ecs',
          'wait',
          'tasks-stopped',
          '--cluster',
          cluster,
          '--tasks',
          arn,
        ]);
      } catch (error) {
        aws(
          'ecs',
          'stop-task',
          '--cluster',
          cluster,
          '--task',
          arn,
          '--reason',
          `${purpose} timeout`,
        );
        throw error;
      }
      const finished = aws(
        'ecs',
        'describe-tasks',
        '--cluster',
        cluster,
        '--tasks',
        arn,
      ).tasks?.[0];
      if (
        finished?.containers?.find(
          (container) => container.name === config.containerName,
        )?.exitCode !== 0
      )
        throw new Error(
          `${name}: ${purpose} failed; inspect CloudWatch task logs`,
        );
    }
    if (config.migrationCommand)
      await oneOff(config.migrationCommand, 'migration');
    try {
      aws(
        'ecs',
        'update-service',
        '--cluster',
        cluster,
        '--service',
        config.ecsService,
        '--task-definition',
        revision,
        ...(bootstrap ? ['--desired-count', '1'] : []),
        '--deployment-configuration',
        JSON.stringify({
          deploymentCircuitBreaker: { enable: true, rollback: true },
        }),
      );
      run('aws', [
        'ecs',
        'wait',
        'services-stable',
        '--cluster',
        cluster,
        '--services',
        config.ecsService,
      ]);
      const deployed = aws(
        'ecs',
        'describe-services',
        '--cluster',
        cluster,
        '--services',
        config.ecsService,
      ).services?.[0];
      if (
        deployed?.taskDefinition !== revision ||
        deployed.desiredCount < 1 ||
        deployed.runningCount < deployed.desiredCount ||
        deployed.pendingCount !== 0 ||
        !deployed.deployments?.some(
          (deployment) =>
            deployment.taskDefinition === revision &&
            deployment.rolloutState === 'COMPLETED',
        )
      )
        throw new Error(`${name}: deployment rolled back or did not complete`);
      if (config.smokeUrl) {
        const response = await fetch(config.smokeUrl, {
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        await response.body?.cancel();
        if (response.status !== 200)
          throw new Error(`${name}: HTTPS smoke check failed`);
      }
      if (config.smokeCommand) await oneOff(config.smokeCommand, 'smoke');
      const record = { sha: sourceSha, image, taskDefinition: revision };
      aws(
        'ssm',
        'put-parameter',
        '--name',
        statePath(name),
        '--type',
        'String',
        '--overwrite',
        '--value',
        JSON.stringify(record),
      );
      console.log(`${name}: ${mode} deployment verified`);
      if (mode === 'staging') release.services.push({ name, image, sourceSha });
    } catch (error) {
      // Keep last-success state unchanged. Secret references in the previous revision remain pinned.
      aws(
        'ecs',
        'update-service',
        '--cluster',
        cluster,
        '--service',
        config.ecsService,
        '--task-definition',
        existing.taskDefinition,
        // A failed first release has no healthy predecessor: return it to stopped.
        ...(bootstrap ? ['--desired-count', '0'] : []),
      );
      run('aws', [
        'ecs',
        'wait',
        'services-stable',
        '--cluster',
        cluster,
        '--services',
        config.ecsService,
      ]);
      throw error;
    }
  }
  if (mode === 'staging')
    writeFileSync('release.json', JSON.stringify(release), { mode: 0o600 });
}
try {
  await deploy();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
