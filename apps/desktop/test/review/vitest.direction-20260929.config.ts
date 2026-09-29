import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/desktop/test/review/direction-quality-20260911.test.ts',
      'apps/desktop/test/review/direction-recheck-20260914.test.ts',
      'apps/desktop/test/review/direction-round2-93ecaed.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
