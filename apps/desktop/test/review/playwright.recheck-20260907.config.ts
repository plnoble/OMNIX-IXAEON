import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['project-audit-ui-20260906.spec.ts', 'recheck-ui-20260907.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  outputDir: './.recheck-ui-20260907',
  use: { trace: 'off' },
});
