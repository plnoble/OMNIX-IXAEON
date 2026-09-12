import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/direction-quality-20260911.test.ts'],
    fileParallelism: false,
    testTimeout: 10000,
  },
});
