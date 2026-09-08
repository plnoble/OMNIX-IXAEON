import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/needs-lifecycle-20260908.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
