import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '../src/config/configuration.js';

describe('configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['0', '-1', '1.5', 'invalid'])('rejects invalid PORT=%s', (port) => {
    vi.stubEnv('PORT', port);

    expect(() => configuration()).toThrow('PORT must be a positive integer');
  });
});
