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
if (!only || only === 'extension') run('extension e2e', resolve(root, 'apps', 'extension'));
