import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'project-audit-ui-20260906.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  outputDir: './.project-audit-ui-out',
  use: { trace: 'off' },
});
