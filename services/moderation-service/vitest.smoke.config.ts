import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/smoke/**/*.smoke.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 10_000,
  },
});
