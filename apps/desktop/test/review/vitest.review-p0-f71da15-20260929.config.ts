import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/desktop/test/review/review-p0-boundaries-20260916.test.ts',
      'apps/desktop/test/review/review-f71da15-20260916.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 10000, // 与合并前原配置一致（Codex 建议：不放宽超时）
  },
});
