#!/usr/bin/env node
/** Windows 安装包：构建 desktop 并运行 electron-builder（NSIS）。 */
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';

const isWindows = platform() === 'win32';
const root = resolve(import.meta.dirname, '..');
const desktop = resolve(root, 'apps', 'desktop');

function run(label, command, args, cwd) {
  const started = Date.now();
  console.log(`\n▶ ${label}`);
  // 剥离 pnpm/corepack 注入的环境变量：electron-builder 的 node-module 收集器
  // 在「pnpm 子进程」中执行 pnpm list --json 会拿到被污染的 stdout（corepack 提示），
  // 导致 "No JSON content found in output"。干净环境下（node 直跑）无此问题。
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|PNPM_|COREPACK_)/i.test(k)) continue;
    cleanEnv[k] = v;
  }
  const result = spawnSync(command, args, {
    cwd,
    shell: isWindows,
    stdio: 'inherit',
    env: {
      ...cleanEnv,
      // NSIS / Electron 二进制按需下载（走系统代理）
      ELECTRON_GET_USE_PROXY: process.env.ELECTRON_GET_USE_PROXY ?? 'true',
      HTTP_PROXY: process.env.HTTP_PROXY ?? '',
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? '',
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`✗ ${label} 失败（${seconds}s）`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${label} 完成（${seconds}s）`);
}

run(
  'mcp build（vite，打包资源用）',
  'node',
  [resolve(root, 'apps', 'mcp', 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
  resolve(root, 'apps', 'mcp'),
);
run(
  'desktop build（electron-vite）',
  'node',
  [
    resolve(root, 'apps', 'desktop', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
    'build',
  ],
  desktop,
);
run(
  'electron-builder（NSIS）',
  'node',
  [
    resolve(desktop, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--win',
    'nsis',
    '--config',
    'electron-builder.yml',
  ],
  desktop,
);
