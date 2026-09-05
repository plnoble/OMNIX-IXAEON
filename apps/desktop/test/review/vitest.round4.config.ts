import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/continuity-round4.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
