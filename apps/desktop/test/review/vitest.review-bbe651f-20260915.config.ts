import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/review-bbe651f-20260915.test.ts'],
    fileParallelism: false,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
