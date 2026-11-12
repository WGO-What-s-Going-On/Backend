export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_URL_SECONDS = 300;
export const IMAGE_UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function profileImageConfig(env = process.env) {
  if (
    env.GCS_PROFILE_ENABLED !== undefined &&
    !['true', 'false'].includes(env.GCS_PROFILE_ENABLED)
  )
    throw new Error('GCS_PROFILE_ENABLED must be true or false');
  const enabled = env.GCS_PROFILE_ENABLED === 'true';
  const bucket = env.GCS_PROFILE_BUCKET ?? '';
  if (enabled && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error('GCS_PROFILE_BUCKET is required and must be a bucket name');
  // Sharing Post's bucket is supported; object ownership is enforced by key and IAM prefix.
  if (enabled && env.NODE_ENV === 'production')
    for (const name of [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'STORAGE_EMULATOR_HOST',
    ])
      if (env[name])
        throw new Error(`${name} must be unset; use Workload Identity`);
  return { enabled, bucket };
}
