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
    env.GCS_MEDIA_ENABLED !== undefined &&
    !['true', 'false'].includes(env.GCS_MEDIA_ENABLED)
  )
    throw new Error('GCS_MEDIA_ENABLED must be true or false');
  const enabled = env.GCS_MEDIA_ENABLED === 'true';
  if (enabled) {
    if (!env.GCS_MEDIA_BUCKET?.trim())
      throw new Error('GCS_MEDIA_BUCKET is required when GCS media is enabled');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.GCS_MEDIA_BUCKET))
      throw new Error('GCS_MEDIA_BUCKET must be a bucket name');
    if (env.NODE_ENV === 'production') {
      for (const name of [
        'GOOGLE_APPLICATION_CREDENTIALS',
        'STORAGE_EMULATOR_HOST',
      ])
        if (env[name])
          throw new Error(
            `${name} must be unset in production; use Workload Identity`,
          );
    }
  }
  return {
    enabled,
    bucket: env.GCS_MEDIA_BUCKET ?? '',
    uploadSeconds: integer(env, 'GCS_MEDIA_UPLOAD_TTL_SECONDS', 300, 900, 5),
    readSeconds: integer(env, 'GCS_MEDIA_READ_TTL_SECONDS', 3600, 3600, 5),
    imageBytes: integer(
      env,
      'GCS_MEDIA_IMAGE_MAX_BYTES',
      10 * 1024 * 1024,
      20 * 1024 * 1024,
    ),
    videoBytes: integer(
      env,
      'GCS_MEDIA_VIDEO_MAX_BYTES',
      100 * 1024 * 1024,
      100 * 1024 * 1024,
    ),
    cleanupMs: integer(env, 'GCS_MEDIA_CLEANUP_INTERVAL_MS', 60000, 3600000),
  };
}
