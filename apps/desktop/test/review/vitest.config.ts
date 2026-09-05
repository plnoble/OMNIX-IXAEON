import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/review-20260905.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
