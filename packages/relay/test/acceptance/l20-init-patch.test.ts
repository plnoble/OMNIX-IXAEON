/**
 * L20 验收测试：`relay init` 生成的开发命令带上 DSH 补丁（委派单「验收」1–5 条，对应契约 1–5 条）。
 *
 * 逐条对应：
 * - 条件 1：临时家目录下有 `.dsh/ixaeon-relay.patch.yml` → 开发 `argv` 与契约第 2 条逐项相等
 *   （`--patch` + 这个文件的绝对路径紧跟在 `headless` 后面）；输出含「带上了」那句；输出里不出现临时家目录的绝对路径。
 * - 条件 2：临时家目录下没有这个文件 → 开发 `argv` 与契约第 3 条逐项相等（一项都不加）；输出含「没带上」那句。
 * - 条件 3：`.dsh/ixaeon-relay.patch.yml` 是个目录不是文件 → 按 `existsSync` 算在，照条件 1（规格定的，不额外判断）。
 * - 条件 4：已经有 `config.json` → 文件内容一个字节不变；输出只有「已经有配置了，没改」，不含条件 4 那两句里的任何一句。
 * - 条件 5：条件 1 生成的配置 `checkConfig` 放行。
 *
 * 全用临时目录（`IXAEON_RELAY_DIR` / `IXAEON_WORKTREES` / `APPDATA` / `USERPROFILE` / `HOME`），
 * 不读、不碰用户真的 `~/.dsh` 和 `~/.ixaeon/relay`。`relay init` 会在真仓库里加一个工作目录（建在临时目录下）：
 * 收尾一定 `git worktree remove --force` + `prune`。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, type RelayConfig } from '../../src/index.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const dirs: string[] = [];
const treeRoots: string[] = [];
const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/** 契约第 2、3 条里写死的开发命令。 */
const DEV_ARGV = ['node', '{relay_root}/packages/relay/bin/dsh.mjs', '--profile', 'headless'];
const DEV_TAIL = ['--json', '读 {prompt_file}，照里面做。'];

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

const envFor = (opts: {
  relayDir: string;
  worktrees: string;
  appdata: string;
  home: string;
}): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_CONFIG_')) delete env[k];
  }
  env.IXAEON_RELAY_DIR = opts.relayDir;
  env.IXAEON_WORKTREES = opts.worktrees;
  env.APPDATA = opts.appdata;
  // 契约第 1 条：补丁文件的位置由 os.homedir() 决定（Windows 读 USERPROFILE）。不指到临时目录就会读到用户真的 ~/.dsh。
  env.USERPROFILE = opts.home;
  env.HOME = opts.home;
  return env;
};

const runInit = (env: Record<string, string | undefined>) =>
  spawnSync(process.execPath, [CLI, 'init'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000,
    env,
  });

const readConfig = (relayDir: string) =>
  JSON.parse(readFileSync(join(relayDir, 'config.json'), 'utf8')) as RelayConfig;

const patchPath = (home: string) => join(home, '.dsh', 'ixaeon-relay.patch.yml');

/** 契约第 2、3 条逐项相等：有补丁 8 项、没补丁 6 项。 */
const expectDevArgv = (argv: string[], patch: string | null) => {
  expect(argv.slice(0, DEV_ARGV.length)).toEqual(DEV_ARGV);
  if (patch) {
    expect(argv.length).toBe(8);
    expect(argv[4]).toBe('--patch');
    expect(norm(argv[5] ?? '')).toBe(norm(patch));
    expect(argv.slice(6)).toEqual(DEV_TAIL);
  } else {
    expect(argv.length).toBe(6);
    expect(argv.slice(4)).toEqual(DEV_TAIL);
  }
};

/** 一次完整的 init 现场：临时数据目录、临时工作目录根、临时 APPDATA、临时家目录。 */
const scene = (prefix: string) => {
  const worktrees = mkTmp(`ixa-${prefix}-trees-`);
  treeRoots.push(worktrees);
  return {
    worktrees,
    relayDir: mkTmp(`ixa-${prefix}-relay-`),
    appdata: mkTmp(`ixa-${prefix}-appdata-`),
    home: mkTmp(`ixa-${prefix}-home-`),
  };
};

describe('条件 1：有补丁文件就带上 --patch', () => {
  it('argv 与契约第 2 条逐项相等；输出含「带上了」，不出现临时家目录的绝对路径', () => {
    const s = scene('l20-yes');
    mkdirSync(join(s.home, '.dsh'), { recursive: true });
    writeFileSync(patchPath(s.home), 'profile: synthetic\n', 'utf8');

    const r = runInit(envFor(s));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('写好了');

    const argv = readConfig(s.relayDir).roles.developer.argv;
    expectDevArgv(argv, patchPath(s.home));

    expect(r.stdout).toContain('开发的命令带上了 DSH 补丁：~/.dsh/ixaeon-relay.patch.yml');
    // 仓库是公开的：路径照原样写 `~/`，不能把展开后的用户目录（这里是临时家目录）打出来。
    expect(r.stdout).not.toContain(s.home);
  }, 300_000);
});

describe('条件 2：没有补丁文件就不带', () => {
  it('argv 与契约第 3 条逐项相等；输出含「没带上」那句', () => {
    const s = scene('l20-no');

    const r = runInit(envFor(s));
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const argv = readConfig(s.relayDir).roles.developer.argv;
    expectDevArgv(argv, null);

    expect(r.stdout).toContain(
      '没找到 ~/.dsh/ixaeon-relay.patch.yml，开发的命令没带 --patch（DSH 会用 headless 默认的设置：DeepSeek 官方 API、关在沙箱里）',
    );
    expect(r.stdout).not.toContain('带上了 DSH 补丁');
  }, 300_000);
});

describe('条件 3：同名的是个目录，按 existsSync 算在', () => {
  it('照条件 1：argv 带上 --patch 和那个路径，输出「带上了」', () => {
    const s = scene('l20-dir');
    // 规格写死：`existsSync` 为真就算在，不额外判断是不是普通文件。
    mkdirSync(patchPath(s.home), { recursive: true });

    const r = runInit(envFor(s));
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const argv = readConfig(s.relayDir).roles.developer.argv;
    expectDevArgv(argv, patchPath(s.home));
    expect(r.stdout).toContain('开发的命令带上了 DSH 补丁：~/.dsh/ixaeon-relay.patch.yml');
  }, 300_000);
});

describe('条件 4：已经有配置就一字不动，也不看补丁文件', () => {
  it('文件内容不变；输出只有「已经有配置了，没改」，不含新那两句里的任何一句', () => {
    const s = scene('l20-exists');
    // 家目录里放上补丁文件：已经有配置时也不许去检查它、更不许打那一行。
    mkdirSync(join(s.home, '.dsh'), { recursive: true });
    writeFileSync(patchPath(s.home), 'profile: synthetic\n', 'utf8');
    const file = join(s.relayDir, 'config.json');
    const existing = `${JSON.stringify(
      {
        roles: {
          integrator: { argv: ['x'], cwd: s.relayDir, timeoutMinutes: 1, quotaPatterns: [] },
          developer: { argv: ['y'], cwd: s.relayDir, timeoutMinutes: 1, quotaPatterns: [] },
        },
        idleSeconds: 60,
      },
      null,
      2,
    )}\n`;
    writeFileSync(file, existing, 'utf8');
    const before = readFileSync(file);

    const r = runInit(envFor(s));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(readFileSync(file)).toEqual(before);
    expect(r.stdout).toContain('已经有配置了，没改');
    expect(r.stdout).not.toContain('开发的命令带上了 DSH 补丁');
    expect(r.stdout).not.toContain('没找到 ~/.dsh/ixaeon-relay.patch.yml');
    expect(r.stdout).not.toContain('写好了');
  }, 300_000);
});

describe('条件 5：带补丁的配置能过配置检查', () => {
  it('条件 1 生成的配置 checkConfig 放行', () => {
    const s = scene('l20-check');
    mkdirSync(join(s.home, '.dsh'), { recursive: true });
    writeFileSync(patchPath(s.home), 'profile: synthetic\n', 'utf8');

    const r = runInit(envFor(s));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const config = readConfig(s.relayDir);

    const old = process.env.IXAEON_RELAY_DIR;
    process.env.IXAEON_RELAY_DIR = s.relayDir;
    try {
      expect(checkConfig(config)).toEqual({ ok: true });
    } finally {
      if (old === undefined) delete process.env.IXAEON_RELAY_DIR;
      else process.env.IXAEON_RELAY_DIR = old;
    }
  }, 300_000);
});
