import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/test/unit/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'packages/*/test/integration/**/*.test.ts',
            'apps/*/test/integration/**/*.test.ts',
          ],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        // 委派流水线：整合方先写好、执行方只能让它通过的验收测试（指纹锁在
        // docs/委派/锁定验收.json）。排队中的任务测试本来就不过，不进日常 unit/integration；
        // 用 node scripts/acceptance.mjs 跑，已完成任务的进门禁。
        test: {
          name: 'acceptance',
          environment: 'node',
          include: [
            'packages/*/test/acceptance/**/*.test.ts',
            'apps/*/test/acceptance/**/*.test.ts',
          ],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
