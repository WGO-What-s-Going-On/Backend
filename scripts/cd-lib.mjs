// Deployment helpers receive external effects explicitly so tests never need AWS credentials.
export async function waitForDeployment(
  readService,
  revision,
  pause,
  attempts = 60,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const service = readService();
    const target = service?.deployments?.find(
      (d) => d.taskDefinition === revision,
    );
    if (
      !service ||
      service.taskDefinition !== revision ||
      !target ||
      target.rolloutState === 'FAILED'
    )
      return false;
    if (target.rolloutState === 'COMPLETED')
      return (
        service.desiredCount >= 1 &&
        service.runningCount >= service.desiredCount &&
        service.pendingCount === 0
      );
    if (attempt + 1 < attempts) await pause();
  }
  return false;
}

export function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} is required`);
  return value;
}

export function parseSecretJson(value, name) {
  try {
    const result = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error();
    return result;
  } catch {
    throw new Error(`${name} must be a JSON object (value omitted)`);
  }
}

export function validateService(name, config, platform) {
  if (!config || typeof config !== 'object')
    throw new Error(`${name}: missing deployment configuration`);
  for (const key of [
    'ecrRepository',
    'ecsService',
    'containerName',
    'runtimeSecretArn',
  ])
    if (typeof config[key] !== 'string' || !config[key].trim())
      throw new Error(`${name}: ${key} is required`);
  if (!/^[a-z0-9][a-z0-9/_.-]*$/.test(config.ecrRepository))
    throw new Error(`${name}: invalid ECR repository name`);
  if (
    !/^arn:aws[a-z-]*:secretsmanager:[\w-]+:\d{12}:secret:/.test(
      config.runtimeSecretArn,
    )
  )
    throw new Error(`${name}: invalid runtime secret ARN`);
  const task = config.taskDefinition;
  if (
    !task ||
    !task.family ||
    task.networkMode !== 'awsvpc' ||
    !task.requiresCompatibilities?.includes('FARGATE') ||
    !task.cpu ||
    !task.memory ||
    !task.executionRoleArn
  )
    throw new Error(`${name}: complete Fargate taskDefinition is required`);
  const containers = task.containerDefinitions?.filter(
    (entry) => entry.name === config.containerName,
  );
  if (
    containers?.length !== 1 ||
    containers[0].essential === false ||
    !containers[0].healthCheck
  )
    throw new Error(
      `${name}: exactly one essential application container with healthCheck is required`,
    );
  const architecture = platform === 'linux/arm64' ? 'ARM64' : 'X86_64';
  if (
    task.runtimePlatform?.cpuArchitecture !== architecture ||
    task.runtimePlatform?.operatingSystemFamily !== 'LINUX'
  )
    throw new Error(`${name}: runtimePlatform must match CD_IMAGE_PLATFORM`);
  for (const key of ['migrationCommand', 'smokeCommand']) {
    if (
      config[key] !== undefined &&
      (!Array.isArray(config[key]) ||
        !config[key].length ||
        config[key].some((item) => typeof item !== 'string'))
    )
      throw new Error(`${name}: ${key} must be a nonempty argv array`);
  }
  if (config.smokeUrl !== undefined && !/^https:\/\//.test(config.smokeUrl))
    throw new Error(`${name}: smokeUrl must use HTTPS`);
  return config;
}

export function renderTask(config, image, runtime, versionId) {
  if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Deployment requires an immutable image digest');
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    Array.isArray(runtime) ||
    Object.values(runtime).some((value) => typeof value !== 'string')
  )
    throw new Error('Runtime secret values must be a string map');
  if (!/^[a-zA-Z0-9-]{32,64}$/.test(versionId))
    throw new Error('Invalid Secrets Manager version ID');
  const names = Object.keys(runtime);
  if (!names.length || names.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name)))
    throw new Error('Runtime secret keys must be environment variable names');
  if (runtime.NODE_ENV !== 'production')
    throw new Error('Runtime NODE_ENV must be production');
  const task = structuredClone(config.taskDefinition);
  const container = task.containerDefinitions.find(
    (entry) => entry.name === config.containerName,
  );
  container.image = image;
  // Pin the secret version; an image rollback must not silently use newer credentials/config.
  container.environment = (container.environment ?? []).filter(
    (entry) => !names.includes(entry.name),
  );
  container.secrets = [
    ...(container.secrets ?? []).filter((entry) => !names.includes(entry.name)),
    ...names.map((name) => ({
      name,
      valueFrom: `${config.runtimeSecretArn}:${name}::${versionId}`,
    })),
  ];
  return task;
}

export function selectReleaseServices(manifest, configured) {
  const known = new Map(
    manifest.services.map((service) => [service.name, service]),
  );
  for (const name of Object.keys(configured))
    if (!known.has(name))
      throw new Error(`Unknown deployment service: ${name}`);
  // Receiver-first order for contracts; only configured services participate in the rollout.
  const order = [
    'user-service',
    'map-service',
    'post-service',
    'notification-service',
    'moderation-service',
    'http-gateway',
    'ws-gateway',
  ];
  return order
    .filter((name) => configured[name])
    .map((name) => known.get(name));
}

export function validateRelease(release, sha) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    release.sha !== sha ||
    !Array.isArray(release.services)
  )
    throw new Error('Invalid release manifest');
  const seen = new Set();
  for (const entry of release.services) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      seen.has(entry.name) ||
      !/^[a-f0-9]{40}$/.test(entry.sourceSha) ||
      !/^[^\s]+@sha256:[a-f0-9]{64}$/.test(entry.image)
    )
      throw new Error('Invalid release entry');
    seen.add(entry.name);
  }
  return release;
}

// Keep non-secret staging access settings versioned with the deployment, not in opaque GitHub JSON.
export function deploymentRuntime(name, mode, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('Runtime secret values must be a string map');
  const runtime = { ...values, DEPLOYMENT_ENV: mode };
  if (name === 'http-gateway')
    runtime.DOCS_ENABLED = String(mode === 'staging');
  if (mode === 'staging' && ['http-gateway', 'ws-gateway'].includes(name)) {
    const key = name === 'http-gateway' ? 'CORS_ORIGINS' : 'WS_ALLOWED_ORIGINS';
    runtime[key] = [
      ...new Set([
        ...(runtime[key] ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        'http://localhost:3000',
        'http://localhost:5173',
      ]),
    ].join(',');
  }
  return runtime;
}
