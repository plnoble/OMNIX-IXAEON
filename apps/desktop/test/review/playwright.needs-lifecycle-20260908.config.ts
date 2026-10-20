import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: ['needs-lifecycle-ui-20260908.spec.ts'],
  // Q2：先把 Electron 二进制准备好（在用例之外），别让两百多兆的同步安装落在 30 秒预算里
  globalSetup: './ensure-electron.ts',
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  outputDir: './.needs-lifecycle-ui-20260908-checked',
  use: { trace: 'off' },
});
