import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      JWT_ACCESS_SECRET: 'ws-test-secret-at-least-32-bytes-long',
      JWT_ACCESS_ISSUER: 'wgo-user-service',
      JWT_ACCESS_AUDIENCE: 'wgo-api',
    },
    include: ['test/**/*.test.ts'],
    coverage: {
      enabled: false,
    },
  },
});
