import { describe, expect, it } from 'vitest';
import { profileImageConfig } from '../src/users/profile-image/profile-image.config.js';

describe('Profile image configuration', () => {
  it('disables storage until explicitly enabled', () => {
    expect(profileImageConfig({})).toEqual({ enabled: false, bucket: '' });
  });
  it('allows the Post media bucket while retaining an explicit profile setting', () => {
    expect(
      profileImageConfig({
        GCS_PROFILE_ENABLED: 'true',
        GCS_PROFILE_BUCKET: 'shared-media',
        GCS_MEDIA_BUCKET: 'shared-media',
      }),
    ).toEqual({ enabled: true, bucket: 'shared-media' });
    expect(() =>
      profileImageConfig({
        GCS_PROFILE_ENABLED: 'true',
        GCS_MEDIA_BUCKET: 'shared-media',
      }),
    ).toThrow('GCS_PROFILE_BUCKET');
  });
  it.each([
    { GCS_PROFILE_ENABLED: 'yes' },
    { GCS_PROFILE_ENABLED: 'true' },
    { GCS_PROFILE_ENABLED: 'true', GCS_PROFILE_BUCKET: 'gs://bucket' },
    {
      GCS_PROFILE_ENABLED: 'true',
      GCS_PROFILE_BUCKET: 'test-profiles',
      NODE_ENV: 'production',
      GOOGLE_APPLICATION_CREDENTIALS: 'key.json',
    },
    {
      GCS_PROFILE_ENABLED: 'true',
      GCS_PROFILE_BUCKET: 'test-profiles',
      NODE_ENV: 'production',
      STORAGE_EMULATOR_HOST: 'localhost',
    },
  ])('rejects unsafe configuration %j', (env) => {
    expect(() => profileImageConfig(env)).toThrow();
  });
});
