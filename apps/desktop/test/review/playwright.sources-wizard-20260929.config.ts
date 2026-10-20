import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['sources-20260908.spec.ts', 'wizard-20260908.spec.ts'],
  // Q2：先把 Electron 二进制准备好（在用例之外），别让两百多兆的同步安装落在用例预算里
  globalSetup: './ensure-electron.ts',
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['list']],
  outputDir: './.sources-wizard-20260929-out',
  use: { trace: 'off' },
});
