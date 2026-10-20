import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/desktop/test/review/v02-acceptance-20260906.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    // 收尾钩子要关库、删临时目录，默认 10 秒在慢的 CI 上会偶发超时（C3a 记录过一次）
    hookTimeout: 30_000,
  },
});
