import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/desktop/test/review/recheck-round2-20260907.test.ts',
      'apps/desktop/test/review/f01-migration.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
