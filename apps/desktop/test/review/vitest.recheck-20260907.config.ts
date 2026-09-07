import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/recheck-20260907.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
