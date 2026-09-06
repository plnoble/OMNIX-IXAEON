import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/v02-acceptance-20260906.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
