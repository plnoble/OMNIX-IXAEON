/**
 * L2 验收测试（二）：网络抖的时候不漏查（规格条件 2、3，对应契约第 2 条）。
 *
 * 逐条对应：
 * - 条件 2：整合方目录的 origin 指到一个连不上的地址 → `once` 不开棒、不记账、不停下
 *   （`stoppedReason` 仍为空）、退出码 0；改回来之后照常开棒。重试真的等了（用时 ≥ 6 秒）。
 * - 条件 3：开发替身在这一棒里把整合方目录的 origin 改成连不上的地址 → 停下，记账那一行
 *   `violations` 里有 `verify-fetch-failed`，`stoppedReason` 里有「拉不下来」；之后 `once`
 *   什么都不跑，`resume` 之后（地址改回来）才接着。
 *
 * 全是临时 git 仓库和替身脚本，不调真模型。数据目录用 IXAEON_RELAY_DIR 指到临时目录。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchMain } from '../../src/index.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');
const dirs: string[] = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ixa-l2-fetch-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};

const QUEUE = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 70 | L7 合成的一行 | [L7](L7.md) | A | 无 | 进行中（dev） |',
  '',
].join('\n');

/** 替身：--mode break-origin 时把整合方目录的 origin 改成连不上的地址，否则照常改状态、提交、推。 */
const STUB = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  'const prompt = readFileSync(argv[0], "utf8");',
  'const mode = argv[argv.indexOf("--mode") + 1];',
  'const clone = argv[argv.indexOf("--clone") + 1];',
  'const integ = argv[argv.indexOf("--integ") + 1];',
  'const g = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });',
  'if (mode === "break-origin") {',
  '  g(integ, "remote", "set-url", "origin", "http://127.0.0.1:1/nowhere.git");',
  '  console.log("RELAY-DONE 70 进行中（dev）");',
  '  process.exit(0);',
  '}',
  'g(clone, "pull", "--ff-only", "-q", "origin", "main");',
  'const q = clone + "/docs/委派/队列.md";',
  'writeFileSync(q, readFileSync(q, "utf8").replace("进行中（dev）", "测试待审（整合方）"), "utf8");',
  'g(clone, "add", "-A");',
  'g(clone, "commit", "-q", "-m", "合成：替身改状态");',
  'g(clone, "push", "-q", "origin", "HEAD:main");',
  'console.log("RELAY-DONE 70 测试待审（整合方）");',
  '',
].join('\n');

function setup() {
  const root = mkTmp();
  const origin = join(root, 'origin.git');
  const integ = join(root, 'integ');
  const dev = join(root, 'dev');
  const dataDir = join(root, 'relay');
  mkdirSync(dataDir, { recursive: true });
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['clone', origin, integ]);
  for (const c of [integ]) {
    git(c, ['config', 'user.email', 'relay@example.invalid']);
    git(c, ['config', 'user.name', 'relay']);
  }
  mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
  writeFileSync(join(integ, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
  git(integ, ['add', '-A']);
  git(integ, ['commit', '-m', '初始合成仓库']);
  git(integ, ['push', 'origin', 'HEAD:main']);
  git(root, ['clone', origin, dev]);
  git(dev, ['config', 'user.email', 'relay@example.invalid']);
  git(dev, ['config', 'user.name', 'relay']);

  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, STUB, 'utf8');
  const role = (cwd: string, mode: string) => ({
    argv: [
      process.execPath,
      stub,
      '{prompt_file}',
      '--mode',
      mode,
      '--clone',
      cwd,
      '--integ',
      integ,
    ],
    cwd,
    timeoutMinutes: 5,
    quotaPatterns: [],
    quotaPauseMinutes: 10,
  });
  const config = {
    roles: { integrator: role(integ, 'ok'), developer: role(dev, 'ok') },
    idleSeconds: 1,
    localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
  };
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify(
      {
        stoppedReason: null,
        pausedUntil: { integrator: '2999-01-01T00:00:00.000Z' },
        turns: 0,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, origin, integ, dev, dataDir };
}

const relay = (dataDir: string, args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, IXAEON_RELAY_DIR: dataDir },
    windowsHide: true,
    timeout: 120_000,
  });
const stateOf = (dataDir: string) =>
  JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as {
    stoppedReason: string | null;
    turns: number;
  };
const ledger = (dataDir: string) => {
  const p = join(dataDir, 'ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { violations: string[] });
};
// 立刻被拒的地址。重试「真的等了」由上面那条 fetchMain 单独量；
// 这里只看调度器对「拉不下来」的反应（不开棒、不记账、不停下）。
const dead = 'http://127.0.0.1:1/nowhere.git';

describe('条件 2：开棒前拉不下来', () => {
  it('fetchMain 连不上 → false，并且真的等了重试（≥ 6 秒）', async () => {
    const s = setup();
    git(s.integ, ['remote', 'set-url', 'origin', dead]);
    const t0 = Date.now();
    const ok = await fetchMain(s.integ);
    // 隔 2 秒、再隔 5 秒，三次都失败才回 false。低于 6 秒就是没真等。
    expect(Date.now() - t0).toBeGreaterThanOrEqual(6_000);
    expect(ok).toBe(false);
  }, 60_000);

  // 现有实现拉不下来也照样开棒（它不管 fetch 的退出码），所以这条在实现写上之前是红的，
  // 红在「这一棒不该开」上，不是红在测试自己。
  it('origin 连不上 → once 不开棒、不记账、不停下、退出码 0；改回来之后照常开棒', () => {
    const s = setup();
    git(s.integ, ['remote', 'set-url', 'origin', dead]);
    const blocked = relay(s.dataDir, ['once']);
    expect(blocked.status, blocked.stderr || blocked.stdout).toBe(0);
    expect(existsSync(join(s.dataDir, 'turns'))).toBe(false);
    expect(stateOf(s.dataDir).stoppedReason ?? null).toBeNull();
    expect(stateOf(s.dataDir).turns).toBe(0);

    git(s.integ, ['remote', 'set-url', 'origin', s.origin]);
    const again = relay(s.dataDir, ['once']);
    expect(again.status, again.stderr || again.stdout).toBe(0);
    expect(stateOf(s.dataDir).turns).toBe(1);
  }, 120_000);
});

describe('条件 3：核对时拉不下来', () => {
  // 同上：现有实现核对时拉不下来也不停下，这条红在「应当记 verify-fetch-failed」上。
  it('这一棒里 origin 被改成连不上的 → 停下，violations 有 verify-fetch-failed；resume 并把地址改回来之后才接着', () => {
    const s = setup();
    const config = JSON.parse(readFileSync(join(s.dataDir, 'config.json'), 'utf8')) as {
      roles: { developer: { argv: string[] } };
    };
    const i = config.roles.developer.argv.indexOf('ok');
    config.roles.developer.argv[i] = 'break-origin';
    writeFileSync(join(s.dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const first = relay(s.dataDir, ['once']);
    expect(first.status, first.stderr || first.stdout).toBe(0);
    const rows = ledger(s.dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.violations).toContain('verify-fetch-failed');
    expect(stateOf(s.dataDir).stoppedReason ?? '').toContain('拉不下来');

    const again = relay(s.dataDir, ['once']);
    expect(again.status).toBe(0);
    expect(ledger(s.dataDir)).toHaveLength(1);

    git(s.integ, ['remote', 'set-url', 'origin', s.origin]);
    expect(relay(s.dataDir, ['resume']).status).toBe(0);
    const after = relay(s.dataDir, ['once']);
    expect(after.status, after.stderr || after.stdout).toBe(0);
    expect(ledger(s.dataDir)).toHaveLength(2);
  }, 120_000);
});
