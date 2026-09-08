import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/closure-b8f216b-20260908.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
