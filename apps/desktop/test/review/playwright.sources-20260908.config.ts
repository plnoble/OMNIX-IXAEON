import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['sources-20260908.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['list']],
  outputDir: './.sources-20260908-out',
  use: { trace: 'off' },
});
