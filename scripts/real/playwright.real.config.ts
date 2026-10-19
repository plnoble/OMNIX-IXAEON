/**
 * `scripts/real/` 下真机 playwright 规格（`.spec.ts`）的跑法配置。
 *
 * 为什么单独一份：仓库根的 `e2e/playwright.config.ts` 已经挪进 `apps/desktop/e2e/`，
 * 而那份的 `testDir` 是 `apps/desktop/e2e`，收集不到 `scripts/real/` 下的规格
 * （直接传文件路径会得到 `Error: No tests found.`）。这份只做一件事：把 `testDir`
 * 指到 `scripts/real/`，其余（超时、并发 1、report）与 e2e 那份保持一致。
 *
 * 跑法（仓库根目录下）：
 *   node apps/desktop/node_modules/@playwright/test/cli.js test \
 *     -c scripts/real/playwright.real.config.ts g06-project-pin.spec.ts
 *
 * 产物（trace、截图）落到 `.logs/playwright-real-out/`（已 gitignore）。
 */
import pw from '../../apps/desktop/node_modules/@playwright/test/index.js';
import type { PlaywrightTestConfig } from '@playwright/test';
import { resolve } from 'node:path';

// 默认导入再取 defineConfig：这份配置落在仓库根（package.json 是 ESM），
// 直接 `import { defineConfig } from …` 去拿 CJS 的具名导出会在 Node 的 ESM 加载器里报
// "Named export 'defineConfig' not found"（apps/desktop 那份是 CJS 包，所以没事）。
const { defineConfig } = pw as unknown as {
  defineConfig: (config: PlaywrightTestConfig) => PlaywrightTestConfig;
};

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'off',
  },
  outputDir: resolve('.logs', 'playwright-real-out'),
});
