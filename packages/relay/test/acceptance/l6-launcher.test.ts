/**
 * L6 验收测试（一）：启动器给 DSH 的 git 设上 OpenSSL（规格条件 1，对应契约第 1 条）。
 *
 * 逐条对应：
 * - 环境里没有 `GIT_CONFIG_PARAMETERS` → 起 DSH 时它是 `'http.sslBackend=openssl'`；
 * - 原来是 `'core.autocrlf=false'` → `'core.autocrlf=false' 'http.sslBackend=openssl'`（原来的放前面、空格隔开）；
 * - **不设** `GIT_CONFIG_COUNT`（L5 那条已被 DSH 擦环境变量堵死，L6 不再用）。
 *
 * 不起真的 DSH：照 L4/L5 的假安装目录 + 替身，替身把收到的环境打出来。
 * 量的是「启动器有没有注对」；`GIT_CONFIG_PARAMETERS` 能不能穿过 DSH 的子进程层由真机检查甲量（已经通了）。
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
  root = mkdtempSync(join(tmpdir(), 'ixa-l6-launcher-'));
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
  writeFileSync(
    cliPath,
    [
      'process.stdout.write(JSON.stringify({',
      '  parameters: process.env.GIT_CONFIG_PARAMETERS ?? null,',
      '  count: process.env.GIT_CONFIG_COUNT ?? null,',
      '  key0: process.env.GIT_CONFIG_KEY_0 ?? null,',
      '  value0: process.env.GIT_CONFIG_VALUE_0 ?? null,',
      '}));',
      '',
    ].join('\n'),
    'utf8',
  );
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 起启动器：先把宿主带进来的那几个 `GIT_CONFIG_*` 清掉，再叠加本次要给的。 */
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
  it('原来没有 GIT_CONFIG_PARAMETERS → 它就是那一项；也不设 GIT_CONFIG_COUNT', () => {
    const r = run({});
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout) as Record<string, string | null>;
    expect(seen.parameters).toBe("'http.sslBackend=openssl'");
    expect(seen.count).toBeNull();
    expect(seen.key0).toBeNull();
    expect(seen.value0).toBeNull();
  }, 60_000);

  it("原来是 'core.autocrlf=false' → 原来的放前面，后面接上 OpenSSL 那一项", () => {
    const r = run({ GIT_CONFIG_PARAMETERS: "'core.autocrlf=false'" });
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout) as Record<string, string | null>;
    expect(seen.parameters).toBe("'core.autocrlf=false' 'http.sslBackend=openssl'");
    expect(seen.count).toBeNull();
  }, 60_000);
});
