import { defineConfig } from '@playwright/test';
// G06 真机检查：node_modules/.bin/playwright test -c apps/desktop/test/real/playwright.g06.config.ts
// 跑的是 scripts/real/g06-project-pin.spec.ts（真实 Electron + 临时数据目录 + 合成数据）。
export default defineConfig({
  testDir: '../../../../scripts/real',
  testMatch: ['g06-project-pin.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['list']],
  outputDir: './.g06-project-pin-checked',
  use: { trace: 'off' },
});
