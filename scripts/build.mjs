#!/usr/bin/env node
/**
 * 构建全部子应用。不经过嵌套 pnpm（避免外层 pnpm 版本 shim 干扰），
 * 直接用 node 调用各构建器 CLI。
 */
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';

const isWindows = platform() === 'win32';
const root = resolve(import.meta.dirname, '..');
const mode = process.argv.includes('--dev') ? 'dev' : 'build';

function run(label, command, args, cwd) {
  const started = Date.now();
  console.log(`\n▶ ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    shell: isWindows,
    stdio: 'inherit',
    env: process.env,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`✗ ${label} 失败（${seconds}s）`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${label} 完成（${seconds}s）`);
}

if (mode === 'dev') {
  // 开发模式：只启动桌面应用（含 HMR）
  run(
    'desktop dev（electron-vite）',
    'node',
    [
      resolve(root, 'apps', 'desktop', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'dev',
    ],
    resolve(root, 'apps', 'desktop'),
  );
} else {
  run(
    'desktop build（electron-vite）',
    'node',
    [
      resolve(root, 'apps', 'desktop', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build',
    ],
    resolve(root, 'apps', 'desktop'),
  );
  run(
    'mcp build（vite lib）',
    'node',
    [resolve(root, 'apps', 'mcp', 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
    resolve(root, 'apps', 'mcp'),
  );
  run(
    'extension build（vite ×3 + 静态复制）',
    'node',
    [resolve(root, 'apps', 'extension', 'scripts', 'build.mjs')],
    resolve(root, 'apps', 'extension'),
  );
}
