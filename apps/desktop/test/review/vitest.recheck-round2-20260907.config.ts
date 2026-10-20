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
    // 收尾钩子要关库、删临时目录，默认 10 秒在慢的 CI 上会偶发超时（C3a 记录过一次）
    hookTimeout: 30000,
  },
});
