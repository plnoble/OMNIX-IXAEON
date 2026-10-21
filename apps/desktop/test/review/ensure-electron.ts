/**
 * Q2：界面测试开跑之前，先把 Electron 二进制准备好——**在用例之外**（Playwright 的 globalSetup）。
 *
 * 为什么需要它：`node_modules/electron` 这个包在 `path.txt` / `dist` 不在的时候，
 * `require('electron')` 会**同步**去装（下载并解压两百多兆，见包自己的 `index.js` 里
 * `getElectronPath()` → `downloadElectron()`）。界面用例第一步就是 `electron.launch()`，
 * 那一截就落在每个用例 30 秒的预算里：
 *   - 装得慢 → `Test timeout of 30000ms exceeded`；
 *   - 装不成（网络/镜像不通、解压被占） → `Electron failed to install correctly`。
 * 两种情况都是「同样的内容，重跑就绿」——门禁和 CI 里冒出来的偶发失败就是它们。
 *
 * 放在 globalSetup 里，这一截就不算进任何用例的预算；装不成也会给一句能照着做的错话。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export default function ensureElectronBinary(config: {
  rootDir?: string;
  config?: { rootDir?: string };
}): void {
  // 这个文件在 apps/desktop/test/review/ 下；electron 是 apps/desktop 的依赖
  // （Playwright 的 globalSetup 收的是 FullConfig，rootDir 在顶层；兜底也认 config.rootDir 那种形状）
  const rootDir = config.rootDir ?? config.config?.rootDir ?? process.cwd();
  const appDir = join(rootDir, '..', '..');
  const requireFromApp = createRequire(join(appDir, 'package.json'));
  let exePath: string;
  try {
    // 这一步在二进制不在时会现场装（在用例之外，不计入 30 秒预算）
    exePath = requireFromApp('electron') as unknown as string;
  } catch (e) {
    throw new Error(
      'Electron 二进制没准备好，界面测试跑不了。先跑一次 `corepack pnpm install`' +
        '（或 `corepack pnpm rebuild electron`）再重跑；原始错误：' +
        (e as Error).message,
    );
  }
  if (typeof exePath !== 'string' || !existsSync(exePath)) {
    throw new Error(
      `Electron 二进制路径不存在（${String(exePath)}）：先跑一次 corepack pnpm install`,
    );
  }
}
