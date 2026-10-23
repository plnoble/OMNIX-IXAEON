/**
 * L14 验收测试（规格 docs/委派/L14-DSH环境里起Electron.md）。
 *
 * 逐条对应「验收」：
 * - `electronArgs(['a', 'b'], {})` → `['a', 'b']`；
 * - `{ IXAEON_ELECTRON_NO_SANDBOX: '1' }` → `['--no-sandbox', 'a', 'b']`；
 * - 值是 `'0'`、`'true'` → 原样；
 * - 不改传进去的数组（两条路都查）；
 * - 假安装目录 + 替身：`dsh.mjs` 起的进程环境里 `IXAEON_ELECTRON_NO_SANDBOX` 是 `'1'`。
 *
 * 另按契约第 2 条查一遍：四个 `playwright.*.config.ts` 的 `testMatch` 点到的六份 spec 里，
 * 每处 `electron.launch` 的参数都经过 `electronArgs`（别处不许再裸起 Electron）。
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronArgs } from '../../../../apps/desktop/test/review/electron-args';

const REPO = process.cwd();
const LAUNCHER = join(REPO, 'packages', 'relay', 'bin', 'dsh.mjs');
const REVIEW = join(REPO, 'apps', 'desktop', 'test', 'review');

let root = '';
let install = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ixa-l14-launcher-'));
  install = join(root, 'install');
  const cli = join(
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
  mkdirSync(join(cli, '..'), { recursive: true });
  copyFileSync(process.execPath, join(install, 'DeepSeek Harness.exe'));
  if (process.platform !== 'win32') chmodSync(join(install, 'DeepSeek Harness.exe'), 0o755);
  writeFileSync(
    cli,
    'process.stdout.write(JSON.stringify({ noSandbox: process.env.IXAEON_ELECTRON_NO_SANDBOX ?? null }));\n',
    'utf8',
  );
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 起启动器；宿主带进来的这个变量先清掉，再叠加本次要给的（照 L6 启动器测试的办法）。 */
const run = (extra: Record<string, string | undefined>) => {
  const env: Record<string, string | undefined> = { ...process.env, IXAEON_DSH_INSTALL: install };
  delete env.IXAEON_ELECTRON_NO_SANDBOX;
  Object.assign(env, extra);
  const r = spawnSync(process.execPath, [LAUNCHER, '--version'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

describe('契约第 1 条：electronArgs', () => {
  it('环境里没有这个变量 → 原样返回', () => {
    const input = ['a', 'b'];
    expect(electronArgs(input, {})).toEqual(['a', 'b']);
    expect(input).toEqual(['a', 'b']);
  });

  it("值是 '1' → 在最前面加 --no-sandbox，传进去的数组不变", () => {
    const input = ['a', 'b'];
    expect(electronArgs(input, { IXAEON_ELECTRON_NO_SANDBOX: '1' })).toEqual([
      '--no-sandbox',
      'a',
      'b',
    ]);
    expect(input).toEqual(['a', 'b']);
  });

  it("值是 '0' / 'true' → 原样返回", () => {
    const zero = ['a', 'b'];
    expect(electronArgs(zero, { IXAEON_ELECTRON_NO_SANDBOX: '0' })).toEqual(['a', 'b']);
    expect(zero).toEqual(['a', 'b']);
    const tru = ['a', 'b'];
    expect(electronArgs(tru, { IXAEON_ELECTRON_NO_SANDBOX: 'true' })).toEqual(['a', 'b']);
    expect(tru).toEqual(['a', 'b']);
  });

  it('默认读 process.env', () => {
    const prev = process.env.IXAEON_ELECTRON_NO_SANDBOX;
    try {
      delete process.env.IXAEON_ELECTRON_NO_SANDBOX;
      expect(electronArgs(['x'])).toEqual(['x']);
      process.env.IXAEON_ELECTRON_NO_SANDBOX = '1';
      expect(electronArgs(['x'])).toEqual(['--no-sandbox', 'x']);
    } finally {
      if (prev === undefined) delete process.env.IXAEON_ELECTRON_NO_SANDBOX;
      else process.env.IXAEON_ELECTRON_NO_SANDBOX = prev;
    }
  });
});

describe('契约第 3 条：启动器给 DSH 设 IXAEON_ELECTRON_NO_SANDBOX=1', () => {
  it('宿主没设 → 起 DSH 时是 1', () => {
    const r = run({});
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ noSandbox: '1' });
  }, 60_000);

  it("宿主原来设了 '0' → 还是强制 1（只让测试里的 Electron 去掉沙箱）", () => {
    const r = run({ IXAEON_ELECTRON_NO_SANDBOX: '0' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ noSandbox: '1' });
  }, 60_000);
});

describe('契约第 2 条：六份界面 spec 里每处 electron.launch 都经过 electronArgs', () => {
  const specs = [
    'needs-lifecycle-ui-20260908.spec.ts',
    'understanding-20260908.spec.ts',
    'sources-20260908.spec.ts',
    'wizard-20260908.spec.ts',
    'project-audit-ui-20260906.spec.ts',
    'recheck-ui-20260907.spec.ts',
  ];

  for (const name of specs) {
    it(`${name}：没有裸的 args 数组`, () => {
      const text = readFileSync(join(REVIEW, name), 'utf8');
      const launches = text.match(/electron\.launch\(/g)?.length ?? 0;
      const wrapped = text.match(/args: electronArgs\(/g)?.length ?? 0;
      expect(launches).toBeGreaterThan(0);
      expect(wrapped).toBe(launches);
    });
  }
});
