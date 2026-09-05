#!/usr/bin/env node
/** 端到端测试入口：desktop（Playwright Electron）+ extension（持久化上下文）。 */
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';

const isWindows = platform() === 'win32';
const root = resolve(import.meta.dirname, '..');

function run(label, cwd) {
  const started = Date.now();
  console.log(`\n▶ ${label}`);
  const cli = resolve(cwd, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = spawnSync('node', [cli, 'test', '-c', 'e2e/playwright.config.ts'], {
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

const only = process.argv[2];
if (!only || only === 'desktop') run('desktop e2e', resolve(root, 'apps', 'desktop'));
if (!only || only === 'extension') {
  // 扩展 e2e 不走 Playwright Test runner（与扩展 SW 共存时触发 Windows
  // 0xC0000409 快速失败）；用纯 node 脚本驱动（断言失败 → 非零退出码）
  runScript('extension e2e', resolve(root, 'apps', 'extension', 'e2e', 'run.cjs'));
}
if (!only || only === 'serial') {
  // 串联验收（四次报告放行条件 2）：真浏览器扩展 → 真实桌面本地服务
  // → 真实 SQLite。覆盖配对、刷新去重、增量、暂停/继续、草稿转正合并。
  runScript(
    'serial e2e（真扩展→真实服务串联）',
    resolve(root, 'apps', 'extension', 'e2e', 'serial-real.cjs'),
  );
}

function runScript(label, scriptPath) {
  const started = Date.now();
  console.log(`\n▶ ${label}`);
  const result = spawnSync('node', [scriptPath], {
    cwd: resolve(root, 'apps', 'extension'),
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
