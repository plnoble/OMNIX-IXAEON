/**
 * L4 验收测试（一）：启动器（规格条件 1，对应契约第 1 条）。
 *
 * 逐条对应：
 * - 假安装目录 + 替身：替身收到的参数是 `--expose-internals <cli.js 路径> <原样的参数…>`（中文参数不乱码）、
 *   环境里有 `ELECTRON_RUN_AS_NODE=1`；替身的标准输出、错误输出、退出码（3）原样回来。
 * - `IXAEON_DSH_INSTALL` 指到不存在的目录 → 退出码 2、错误输出有「没找到 DSH 的安装目录」。
 *
 * 不起真的 DSH：假安装目录里放一份 `process.execPath` 当 `DeepSeek Harness.exe`，假的 `cli.js` 就是替身。
 * 输出走管道、不落盘；不碰用户的 ~/.dsh。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const LAUNCHER = join(REPO, 'packages', 'relay', 'bin', 'dsh.mjs');

let root = '';
let install = '';
let cliPath = '';
let missing = '';

/** 假安装目录：DeepSeek Harness.exe（node 的副本）+ resources/app.asar/.../cli.js（替身）。 */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ixa-l4-launcher-'));
  install = join(root, 'install');
  missing = join(root, 'nowhere');
  cliPath = join(
    install,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
  mkdirSync(join(install, 'resources', 'app.asar'), { recursive: true });
  mkdirSync(join(cliPath, '..'), { recursive: true });
  copyFileSync(process.execPath, join(install, 'DeepSeek Harness.exe'));
  if (process.platform !== 'win32') chmodSync(join(install, 'DeepSeek Harness.exe'), 0o755);
  writeFileSync(
    cliPath,
    [
      'process.stdout.write(JSON.stringify({',
      '  execArgv: process.execArgv,',
      '  argv: process.argv.slice(1),',
      '  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
      '}));',
      'console.error("替身的 stderr 一行");',
      'process.exit(3);',
      '',
    ].join('\n'),
    'utf8',
  );
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const runLauncher = (args: string[], env: Record<string, string | undefined>) =>
  spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, IXAEON_DSH_INSTALL: undefined, ...env },
  });

describe('条件 1：启动器', () => {
  it('把 --expose-internals 和 cli.js 放在原参数前面；参数原样（中文不乱码）；ELECTRON_RUN_AS_NODE=1；输出与退出码原样', () => {
    const args = ['--profile', 'headless', '--json', '读 {prompt_file}，照里面做。'];
    const r = runLauncher(args, { IXAEON_DSH_INSTALL: install });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain('替身的 stderr 一行');
    const seen = JSON.parse(r.stdout) as {
      execArgv: string[];
      argv: string[];
      runAsNode: string | null;
    };
    expect(seen.execArgv).toContain('--expose-internals');
    expect(seen.argv[0]).toBe(cliPath);
    expect(seen.argv.slice(1)).toEqual(args);
    expect(seen.runAsNode).toBe('1');
  }, 60_000);

  it('IXAEON_DSH_INSTALL 指到不存在的目录 → 退出码 2、说「没找到 DSH 的安装目录」', () => {
    const r = runLauncher(['--profile', 'headless'], { IXAEON_DSH_INSTALL: missing });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain('没找到 DSH 的安装目录');
  }, 60_000);

  // 整合方补（2026-10-22，复审实现时）：真机上 resources/app.asar 是一个**文件**（cli.js 在它里面，
  // 只有 Electron 穿得进去）。启动器不能往 app.asar 里面探 cli.js，不然真机上永远「没找到」。
  it('app.asar 是文件（跟真机一样）→ 照样认出安装目录，不报「没找到」', () => {
    const asarFile = join(root, 'install-asar-file');
    mkdirSync(join(asarFile, 'resources'), { recursive: true });
    copyFileSync(process.execPath, join(asarFile, 'DeepSeek Harness.exe'));
    if (process.platform !== 'win32') chmodSync(join(asarFile, 'DeepSeek Harness.exe'), 0o755);
    writeFileSync(join(asarFile, 'resources', 'app.asar'), 'not a real asar', 'utf8');
    const r = runLauncher(['--version'], { IXAEON_DSH_INSTALL: asarFile });
    // 替身（node 的副本）穿不进假的 asar，会自己报错退出；要的只是「找到了安装目录、真的起了它」
    expect(`${r.stdout}${r.stderr}`).not.toContain('没找到 DSH 的安装目录');
    expect(r.status).not.toBe(2);
  }, 60_000);
});
