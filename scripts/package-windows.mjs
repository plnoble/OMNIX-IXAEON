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
  const result = spawnSync(command, args, {
    cwd,
    shell: isWindows,
    stdio: 'inherit',
    env: {
      ...process.env,
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
