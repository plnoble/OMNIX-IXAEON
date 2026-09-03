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
    ],
  },
});
