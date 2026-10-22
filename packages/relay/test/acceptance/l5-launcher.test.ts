/**
 * L5 验收测试（一）：启动器给 DSH 的 git 设上 OpenSSL（规格条件 1，对应契约第 1 条）。
 *
 * 逐条对应：
 * - 环境里没有 `GIT_CONFIG_COUNT` → 起 DSH 时 `COUNT=1`、`KEY_0=http.sslBackend`、`VALUE_0=openssl`；
 * - 原来有 `COUNT=1`（`KEY_0=core.autocrlf`、`VALUE_0=false`）→ `COUNT=2`、第 0 项原样保留、第 1 项是
 *   `http.sslBackend=openssl`。
 *
 * 不起真的 DSH：照 L4 的假安装目录 + 替身，替身把收到的 `GIT_CONFIG_*` 打出来。
 * 注意这里量的是**启动器有没有把变量注进环境**；这些变量能不能穿过 DSH 自己的子进程层，是另一回事
 * （真机检查甲里量到 DSH 会把名字里带 `KEY` 的变量擦掉，见交付说明）。
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

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ixa-l5-launcher-'));
  install = join(root, 'install');
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
  // 替身：把自己收到的 git 配置打成一行 JSON
  writeFileSync(
    cliPath,
    [
      'process.stdout.write(JSON.stringify({',
      '  count: process.env.GIT_CONFIG_COUNT ?? null,',
      '  key0: process.env.GIT_CONFIG_KEY_0 ?? null,',
      '  value0: process.env.GIT_CONFIG_VALUE_0 ?? null,',
      '  key1: process.env.GIT_CONFIG_KEY_1 ?? null,',
      '  value1: process.env.GIT_CONFIG_VALUE_1 ?? null,',
      '}));',
      '',
    ].join('\n'),
    'utf8',
  );
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 起启动器，环境里去掉宿主带进来的 GIT_CONFIG_*，再叠加本次要给的。 */
const run = (extra: Record<string, string | undefined>) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_CONFIG_')) delete env[k];
  }
  env.IXAEON_DSH_INSTALL = install;
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, [LAUNCHER, '--profile', 'headless'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

describe('条件 1：启动器给 DSH 的 git 设上 OpenSSL', () => {
  it('原来没有 GIT_CONFIG_COUNT → COUNT=1、KEY_0=http.sslBackend、VALUE_0=openssl', () => {
    const r = run({});
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout) as Record<string, string | null>;
    expect(seen.count).toBe('1');
    expect(seen.key0).toBe('http.sslBackend');
    expect(seen.value0).toBe('openssl');
  }, 60_000);

  it('原来有 COUNT=1（core.autocrlf=false）→ COUNT=2、第 0 项原样、第 1 项是 OpenSSL', () => {
    const r = run({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
    });
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout) as Record<string, string | null>;
    expect(seen.count).toBe('2');
    expect(seen.key0).toBe('core.autocrlf');
    expect(seen.value0).toBe('false');
    expect(seen.key1).toBe('http.sslBackend');
    expect(seen.value1).toBe('openssl');
  }, 60_000);
});
