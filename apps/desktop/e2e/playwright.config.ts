import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'off',
  },
  outputDir: resolve('e2e', '.playwright-out'),
});
