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
    testTimeout: 10000, // 与合并前原配置一致（Codex 建议：不放宽超时）
  },
});
