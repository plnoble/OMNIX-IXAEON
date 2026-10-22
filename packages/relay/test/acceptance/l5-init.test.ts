/**
 * L5 验收测试（二）：`relay init` 一键生成真用的配置（规格条件 2–5，对应契约第 2 条）。
 *
 * 逐条对应：
 * - 条件 2：写出的 `config.json` 是合法 JSON；整合方 `argv[0]` 是假 `claude.exe` 的路径；整合方 `cwd` 是
 *   `<IXAEON_WORKTREES>/relay-int` 且是 git 工作目录、停在 `origin/main`；开发 `argv` 有启动器的绝对路径和
 *   `--profile headless --json`、`cwd` 是 `<IXAEON_WORKTREES>`；`--add-dir` 后面是 `<数据目录>/turns`；
 *   没有任何「跳过所有权限」的开关；`checkConfig` 放行。
 * - 条件 3：`APPDATA` 下没有 `claude.exe`、PATH 里也没有 → 整合方 `argv[0]` 是 `claude`，输出含
 *   「没找到 Claude Code 的可执行文件」。
 * - 条件 4：数据目录里已有 `config.json` → 逐字节不改，输出「已经有配置了，没改」，退出码 0。
 * - 条件 5：`IXAEON_RELAY_DIR` 设成 `<IXAEON_WORKTREES>/relay`（开发的 cwd 就包着数据目录）→ 退出码 1、
 *   数据目录里没有留下 `config.json`。
 *
 * 全用临时目录（`IXAEON_RELAY_DIR` / `IXAEON_WORKTREES` / `APPDATA` / `PATH`），不碰用户本机的数据目录。
 * `relay init` 会在真仓库里加一个工作目录（建在临时目录下）：收尾一定 `git worktree remove --force` + `prune`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, FORBIDDEN_SWITCHES, type RelayConfig } from '../../src/index.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const dirs: string[] = [];
const treeRoots: string[] = [];
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

const mkTmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** 收尾：先把临时目录里建出来的工作目录从真仓库摘掉，再删临时目录（顺序不能反）。 */
afterEach(() => {
  for (const root of treeRoots.splice(0)) {
    spawnSync('git', ['worktree', 'remove', '--force', join(root, 'relay-int')], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** PATH 收紧时也要留着的那个目录：git 可执行文件在哪（`relay init` 要用它建工作目录）。 */
const gitDir = (() => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const first = ((r.stdout ?? '').split('\n')[0] ?? '').trim();
  return first ? dirname(first) : '';
})();

const envFor = (opts: { relayDir: string; worktrees: string; appdata: string; path?: string }) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_CONFIG_')) delete env[k];
  }
  env.IXAEON_RELAY_DIR = opts.relayDir;
  env.IXAEON_WORKTREES = opts.worktrees;
  env.APPDATA = opts.appdata;
  if (opts.path) env.PATH = opts.path;
  return env;
};

const runInit = (env: Record<string, string | undefined>) =>
  spawnSync(process.execPath, [CLI, 'init'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    env,
  });

const readConfig = (relayDir: string) =>
  JSON.parse(readFileSync(join(relayDir, 'config.json'), 'utf8')) as RelayConfig;

/** 在临时目录里放一个假的 claude.exe（只要求它在，不要跑）。 */
const putFakeClaude = (appdata: string) => {
  const p = join(
    appdata,
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'stub\n', 'utf8');
  return p;
};

describe('条件 2：relay init 写配置', () => {
  it('写出的 config.json 形状对、工作目录建在临时目录下、checkConfig 放行', () => {
    const worktrees = mkTmp('ixa-l5-trees-');
    treeRoots.push(worktrees);
    const relayDir = mkTmp('ixa-l5-relay-');
    const appdata = mkTmp('ixa-l5-appdata-');
    const claudeExe = putFakeClaude(appdata);

    const r = runInit(envFor({ relayDir, worktrees, appdata }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('写好了');
    expect(existsSync(join(relayDir, 'config.json'))).toBe(true);
    const config = readConfig(relayDir);

    // 整合方：假 claude.exe 的路径 + cwd 在 <工作目录根>/relay-int
    expect(config.roles.integrator.argv[0]).toBe(claudeExe);
    const intCwd = join(worktrees, 'relay-int');
    expect(norm(config.roles.integrator.cwd)).toBe(norm(intCwd));

    // 那个 cwd 真的是 git 工作目录，且停在 origin/main
    const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    }).stdout;
    expect(norm(listed)).toContain(norm(intCwd));
    const head = spawnSync('git', ['-C', intCwd, 'rev-parse', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    }).stdout.trim();
    const originMain = spawnSync('git', ['rev-parse', 'origin/main'], {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
    }).stdout.trim();
    expect(head).toBe(originMain);

    // 开发：启动器的绝对路径 + --profile headless --json，cwd 就是工作目录根
    const devArgv = config.roles.developer.argv;
    expect(devArgv[0]).toBe('node');
    expect((devArgv[1] ?? '').replaceAll('\\', '/')).toBe(
      join(REPO, 'packages', 'relay', 'bin', 'dsh.mjs').replaceAll('\\', '/'),
    );
    expect(devArgv).toContain('--profile');
    expect(devArgv).toContain('headless');
    expect(devArgv).toContain('--json');
    expect(devArgv.some((a) => a.includes('{prompt_file}'))).toBe(true);
    expect(norm(config.roles.developer.cwd)).toBe(norm(worktrees));

    // --add-dir 后面是 <数据目录>/turns
    const i = config.roles.integrator.argv.indexOf('--add-dir');
    expect(i).toBeGreaterThan(-1);
    expect(norm(config.roles.integrator.argv[i + 1] ?? '')).toBe(norm(join(relayDir, 'turns')));

    // 没有任何「跳过所有权限」的开关；checkConfig 放行
    const text = JSON.stringify(config);
    for (const sw of FORBIDDEN_SWITCHES) expect(text).not.toContain(sw);
    const old = process.env.IXAEON_RELAY_DIR;
    process.env.IXAEON_RELAY_DIR = relayDir;
    try {
      expect(checkConfig(config)).toEqual({ ok: true });
    } finally {
      if (old === undefined) delete process.env.IXAEON_RELAY_DIR;
      else process.env.IXAEON_RELAY_DIR = old;
    }
  }, 120_000);
});

describe('条件 3：没找到 Claude', () => {
  it('APPDATA 和 PATH 里都没有 → argv[0] 写 claude，输出「没找到 Claude Code 的可执行文件」', () => {
    const worktrees = mkTmp('ixa-l5-trees-');
    treeRoots.push(worktrees);
    const relayDir = mkTmp('ixa-l5-relay-');
    const appdata = mkTmp('ixa-l5-appdata-');
    // PATH 收紧：只留 node 所在的目录和 git 所在的目录（git 留着，不然 init 建不了工作目录）
    const smallPath = [dirname(process.execPath), gitDir].filter(Boolean).join(delimiter);

    const r = runInit(envFor({ relayDir, worktrees, appdata, path: smallPath }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('没找到 Claude Code 的可执行文件');
    expect(readConfig(relayDir).roles.integrator.argv[0]).toBe('claude');
  }, 120_000);
});

describe('条件 4：已经有配置就不动', () => {
  it('逐字节不改，输出「已经有配置了，没改」，退出码 0', () => {
    const worktrees = mkTmp('ixa-l5-trees-');
    const relayDir = mkTmp('ixa-l5-relay-');
    const appdata = mkTmp('ixa-l5-appdata-');
    const existing = `${JSON.stringify(
      {
        roles: {
          integrator: { argv: ['x'], cwd: relayDir, timeoutMinutes: 1, quotaPatterns: [] },
          developer: { argv: ['y'], cwd: relayDir, timeoutMinutes: 1, quotaPatterns: [] },
        },
        idleSeconds: 60,
      },
      null,
      2,
    )}\n`;
    const file = join(relayDir, 'config.json');
    writeFileSync(file, existing, 'utf8');
    const before = readFileSync(file);

    const r = runInit(envFor({ relayDir, worktrees, appdata }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('已经有配置了，没改');
    expect(readFileSync(file)).toEqual(before);
  }, 120_000);
});

describe('条件 5：配置检查不过就不留文件', () => {
  it('数据目录放在工作目录根下面（开发的 cwd 包着它）→ 退出码 1、不留下 config.json', () => {
    const worktrees = mkTmp('ixa-l5-trees-');
    treeRoots.push(worktrees);
    const relayDir = join(worktrees, 'relay');
    mkdirSync(relayDir, { recursive: true });
    const appdata = mkTmp('ixa-l5-appdata-');
    putFakeClaude(appdata);

    const r = runInit(envFor({ relayDir, worktrees, appdata }));
    expect(r.status, r.stderr || r.stdout).toBe(1);
    expect(existsSync(join(relayDir, 'config.json'))).toBe(false);
    // 还要说清是哪个角色（契约第 2 条「打印原因」+ 契约第 3 条「说清是哪个角色」）：
    // 光看退出码 1 分不清「配置没过」和「init 根本没实现」，所以这条也算上。
    expect(`${r.stdout}${r.stderr}`).toContain('developer');
  }, 120_000);
});
