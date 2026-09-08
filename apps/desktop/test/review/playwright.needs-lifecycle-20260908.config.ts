import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['needs-lifecycle-ui-20260908.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  outputDir: './.needs-lifecycle-ui-20260908-checked',
  use: { trace: 'off' },
});
