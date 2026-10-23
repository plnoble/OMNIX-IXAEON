/**
 * L4 验收测试（二）：数据目录的位置与旧位置提醒（规格条件 2、3，对应契约第 2 条）。
 *
 * 逐条对应：
 * - 条件 2：没有 `IXAEON_RELAY_DIR` 时，`relay status` 用的是 `LOCALAPPDATA` 下的 `IXAEON/relay`
 *   （测试把 `LOCALAPPDATA` 指到临时目录）；有 `IXAEON_RELAY_DIR` 时用它；
 *   `loadFeishuTarget()` 的默认路径跟着走（读的是新默认，不是旧的 `<Worktrees>/IXAEON/relay`）。
 * - 条件 3：旧数据目录里有 `state.json` → `relay status` 多打「旧的数据目录里还有文件：<旧路径>…」，
 *   输出里不含那个文件的内容；旧目录是空的 → 不打。
 *
 * 全程用临时目录：`IXAEON_RELAY_DIR` / `LOCALAPPDATA` / `IXAEON_WORKTREES` 都指到临时目录，
 * 不读、不写用户本机真的数据目录。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFeishuTarget } from '../../src/notify/feishu.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const dirs: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 新默认的数据目录：Windows 是 `%LOCALAPPDATA%/IXAEON/relay`，别的系统是 `~/.local/share/ixaeon/relay`。 */
const newDefault = (localAppData: string, home: string) =>
  process.platform === 'win32'
    ? join(localAppData, 'IXAEON', 'relay')
    : join(home, '.local', 'share', 'ixaeon', 'relay');

/** 起 CLI 时用的环境：把三个位置都显式给死，不碰用户本机的任何数据目录。 */
const envFor = (opts: {
  relayDir?: string;
  localAppData: string;
  worktrees: string;
  home: string;
}) => {
  const env = { ...process.env };
  delete env.IXAEON_RELAY_DIR;
  delete env.IXAEON_NOW;
  env.LOCALAPPDATA = opts.localAppData;
  env.HOME = opts.home;
  env.IXAEON_WORKTREES = opts.worktrees;
  if (opts.relayDir) env.IXAEON_RELAY_DIR = opts.relayDir;
  return env;
};

/** `relay status` 第一段 JSON 里的 dataDir。 */
const dataDirOf = (stdout: string): string => {
  const m = /"dataDir":\s*"((?:[^"\\]|\\.)*)"/.exec(stdout);
  if (!m) throw new Error(`status 输出里没有 dataDir：${stdout}`);
  return JSON.parse(`"${m[1]}"`) as string;
};
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * 整合方改（2026-10-23，L8）：L8 起 status 打印时把用户目录换成 `~`。比路径之前先把打印里的
 * `~` 换回子进程的用户目录（Windows 上是本机的，别的系统是测试给的 `HOME`），换回来之后
 * 还是要和原来一样逐字相等——条件没放宽，L8 之前原样打印的写法也照样过。
 */
const childHome = (home: string) => (process.platform === 'win32' ? homedir() : home);
const expandHome = (text: string, home: string) =>
  text.replace(/(^|[\s"：])~(?=[\\/])/g, (_m, pre: string) => `${pre}${childHome(home)}`);

const status = (env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [CLI, 'status'], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env,
  });

describe('条件 2：数据目录的位置', () => {
  it('没有 IXAEON_RELAY_DIR → 用 LOCALAPPDATA 下的 IXAEON/relay（不是旧的 Worktrees 位置）', () => {
    const localAppData = mkTmp('ixa-l4-appdata-');
    const worktrees = mkTmp('ixa-l4-trees-');
    const home = mkTmp('ixa-l4-home-');
    const r = status(envFor({ localAppData, worktrees, home }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(norm(expandHome(dataDirOf(r.stdout), home))).toBe(norm(newDefault(localAppData, home)));
  }, 60_000);

  it('有 IXAEON_RELAY_DIR 时用它', () => {
    const localAppData = mkTmp('ixa-l4-appdata-');
    const worktrees = mkTmp('ixa-l4-trees-');
    const home = mkTmp('ixa-l4-home-');
    const relayDir = mkTmp('ixa-l4-relay-');
    const r = status(envFor({ relayDir, localAppData, worktrees, home }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(norm(expandHome(dataDirOf(r.stdout), home))).toBe(norm(relayDir));
  }, 60_000);

  it('loadFeishuTarget() 的默认路径跟着新默认走，不读旧的 Worktrees 位置', () => {
    const localAppData = mkTmp('ixa-l4-appdata-');
    const worktrees = mkTmp('ixa-l4-trees-');
    const home = mkTmp('ixa-l4-home-');
    const fresh = newDefault(localAppData, home);
    mkdirSync(fresh, { recursive: true });
    writeFileSync(
      join(fresh, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: 'http://127.0.0.1:1/fresh', secret: 'synthetic-fresh' })}\n`,
      'utf8',
    );
    // 旧位置也放一份不一样的：读错了就会露出来
    mkdirSync(join(worktrees, 'relay'), { recursive: true });
    writeFileSync(
      join(worktrees, 'relay', 'feishu.json'),
      `${JSON.stringify({ webhookUrl: 'http://127.0.0.1:1/stale', secret: 'synthetic-stale' })}\n`,
      'utf8',
    );

    const env = envFor({ localAppData, worktrees, home });
    const old = { ...process.env };
    Object.assign(process.env, env);
    try {
      const target = loadFeishuTarget();
      expect(target?.webhookUrl).toBe('http://127.0.0.1:1/fresh');
    } finally {
      for (const k of ['LOCALAPPDATA', 'HOME', 'IXAEON_WORKTREES', 'IXAEON_RELAY_DIR']) {
        if (old[k] === undefined) delete process.env[k];
        else process.env[k] = old[k];
      }
    }
  });
});

describe('条件 3：旧位置提醒', () => {
  it('旧数据目录里有 state.json → 多打一行「旧的数据目录里还有文件」，且不打印内容', () => {
    const localAppData = mkTmp('ixa-l4-appdata-');
    const worktrees = mkTmp('ixa-l4-trees-');
    const home = mkTmp('ixa-l4-home-');
    const relayDir = mkTmp('ixa-l4-relay-');
    const oldDir = join(worktrees, 'relay');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, 'state.json'),
      `${JSON.stringify({ stoppedReason: 'SENTINEL-不该出现' })}\n`,
      'utf8',
    );
    const r = status(envFor({ relayDir, localAppData, worktrees, home }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('旧的数据目录里还有文件');
    expect(norm(expandHome(r.stdout, home))).toContain(norm(oldDir));
    expect(r.stdout).not.toContain('SENTINEL-不该出现');
  }, 60_000);

  // 整合方补（2026-10-22）：用户本机真实的情况——旧位置里只有 feishu.json；提醒里不许带出地址和密钥
  it('旧数据目录里只有 feishu.json → 也提醒，且不打出地址和密钥', () => {
    const localAppData = mkTmp('ixa-l4-appdata-');
    const worktrees = mkTmp('ixa-l4-trees-');
    const home = mkTmp('ixa-l4-home-');
    const relayDir = mkTmp('ixa-l4-relay-');
    const oldDir = join(worktrees, 'relay');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, 'feishu.json'),
      `${JSON.stringify({ webhookUrl: 'http://127.0.0.1:1/hook-SENTINEL', secret: 'secret-SENTINEL' })}\n`,
      'utf8',
    );
    const r = status(envFor({ relayDir, localAppData, worktrees, home }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toContain('旧的数据目录里还有文件');
    expect(`${r.stdout}${r.stderr}`).not.toContain('SENTINEL');
  }, 60_000);

  it('旧目录是空的 → 不打那一行', () => {
    const localAppData = mkTmp('ixa-l4-appdata-');
    const worktrees = mkTmp('ixa-l4-trees-');
    const home = mkTmp('ixa-l4-home-');
    const relayDir = mkTmp('ixa-l4-relay-');
    mkdirSync(join(worktrees, 'relay'), { recursive: true });
    const r = status(envFor({ relayDir, localAppData, worktrees, home }));
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).not.toContain('旧的数据目录里还有文件');
  }, 60_000);
});
