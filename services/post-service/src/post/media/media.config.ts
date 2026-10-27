function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
  minimum = 1,
) {
  const n = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum)
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  return n;
}
export function mediaConfig(env = process.env) {
  if (
    env.S3_MEDIA_ENABLED !== undefined &&
    !['true', 'false'].includes(env.S3_MEDIA_ENABLED)
  )
    throw new Error('S3_MEDIA_ENABLED must be true or false');
  const enabled = env.S3_MEDIA_ENABLED === 'true';
  if (enabled) {
    for (const name of ['AWS_REGION', 'S3_MEDIA_BUCKET'])
      if (!env[name]?.trim())
        throw new Error(`${name} is required when S3 media is enabled`);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_MEDIA_BUCKET!))
      throw new Error('S3_MEDIA_BUCKET must be a bucket name');
    if (env.NODE_ENV === 'production') {
      for (const name of [
        'S3_MEDIA_ENDPOINT',
        'AWS_ENDPOINT_URL',
        'AWS_ENDPOINT_URL_S3',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'AWS_PROFILE',
      ])
        if (env[name])
          throw new Error(
            `${name} must be unset in production; use the ECS Task Role`,
          );
    }
    if (env.S3_MEDIA_ENDPOINT) {
      let url: URL;
      try {
        url = new URL(env.S3_MEDIA_ENDPOINT);
      } catch {
        throw new Error('Invalid S3_MEDIA_ENDPOINT');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error('Invalid S3_MEDIA_ENDPOINT');
    }
  }
  return {
    enabled,
    bucket: env.S3_MEDIA_BUCKET ?? '',
    region: env.AWS_REGION ?? 'ap-northeast-2',
    endpoint: env.S3_MEDIA_ENDPOINT,
    uploadSeconds: integer(env, 'S3_MEDIA_UPLOAD_TTL_SECONDS', 300, 900, 5),
    readSeconds: integer(env, 'S3_MEDIA_READ_TTL_SECONDS', 300, 900, 5),
    imageBytes: integer(
      env,
      'S3_MEDIA_IMAGE_MAX_BYTES',
      10 * 1024 * 1024,
      20 * 1024 * 1024,
    ),
    videoBytes: integer(
      env,
      'S3_MEDIA_VIDEO_MAX_BYTES',
      100 * 1024 * 1024,
      100 * 1024 * 1024,
    ),
    cleanupMs: integer(env, 'S3_MEDIA_CLEANUP_INTERVAL_MS', 60000, 3600000),
  };
}
