/**
 * L18 验收（委派单 docs/委派/L18-看门人换了代码自己重起.md，条件 1–7）。
 *
 * 1. `relayCodeHash`：同样文件两次一样；改 `src/` 一个字、`bin/` 加文件、改文件名都变；
 *    改 `test/` 或 README 不变。
 * 2. forever 底下、没设 IXAEON_RELAY_CODE：relay-run 里的看门人那层和自己不一样 → 退 75、
 *    输出含「看门人自己的代码换了」、这一轮没起 once、锁放掉了。
 * 3. 同 2 代码一样 → 照常起棒，不以 75 退。
 * 4. 没设 IXAEON_RELAY_FOREVER → 不一样也照常起棒。
 * 5. `relay forever` + 替身（1、2 次退 75，第 3 次退 4）→ 退 4、被起 3 次、参数 `run --exit-when-idle`、
 *    环境有 IXAEON_RELAY_FOREVER=1、「重起」正好 2 行。
 * 6. 替身一直退 75 → 退 1、含「重起了 6 次，停下」、被起 6 次。
 * 7. 替身退 0 → 退 0、只起 1 次。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { relayCodeHash, RESTART_EXIT_CODE } from '../../src/selfupdate.js';
import { makeWorld, type World } from './l10-harness.js';

const REPO = process.cwd();
const CLI = join(REPO, 'packages', 'relay', 'bin', 'relay.mjs');

const worlds: World[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) {
    if (w.root) rmSync(w.root, { recursive: true, force: true });
  }
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

/** 复制一份本仓库的 relay 源码树（只 packages/relay 和根上的 package.json 等），当成「另一个仓库」。 */
function copyRelayTree(dest: string): void {
  mkdirSync(join(dest, 'packages', 'relay'), { recursive: true });
  for (const sub of ['bin', 'src', 'test']) {
    spawnSync(
      'robocopy',
      [
        join(REPO, 'packages', 'relay', sub),
        join(dest, 'packages', 'relay', sub),
        '/E',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
      ],
      { windowsHide: true },
    );
  }
}

describe('条件 1：relayCodeHash', () => {
  it('同样的文件两次一样；改 src 一个字、bin 加文件、改文件名都变；改 test 或 README 不变', () => {
    const base = temp('ixa-l18-hash-');
    copyRelayTree(base);
    const h1 = relayCodeHash(base);
    expect(relayCodeHash(base)).toBe(h1);
    // 改 test/ 下一个文件：不变（test 不算看门人那层）
    const testFile = join(base, 'packages', 'relay', 'test', 'l18-marker.txt');
    writeFileSync(testFile, 'marker', 'utf8');
    expect(relayCodeHash(base)).toBe(h1);
    // README 不算
    writeFileSync(join(base, 'packages', 'relay', 'README.md'), '变了\n', 'utf8');
    expect(relayCodeHash(base)).toBe(h1);
    // 改 src/ 下一个字 → 变
    const srcFile = join(base, 'packages', 'relay', 'src', 'selfupdate.ts');
    writeFileSync(srcFile, `${readFileSync(srcFile, 'utf8')}\n// 一点不同\n`, 'utf8');
    const h2 = relayCodeHash(base);
    expect(h2).not.toBe(h1);
    // bin/ 下加一个文件 → 变
    writeFileSync(join(base, 'packages', 'relay', 'bin', 'extra.mjs'), '// 新\n', 'utf8');
    const h3 = relayCodeHash(base);
    expect(h3).not.toBe(h2);
    // 改文件名 → 变（内容挪个名）
    const binA = join(base, 'packages', 'relay', 'bin', 'a-marker.mjs');
    writeFileSync(binA, '// 甲\n', 'utf8');
    const h4 = relayCodeHash(base);
    rmSync(binA);
    writeFileSync(join(base, 'packages', 'relay', 'bin', 'b-marker.mjs'), '// 甲\n', 'utf8');
    expect(relayCodeHash(base)).not.toBe(h4);
  });
});

/**
 * 条件 2–4 的场：合成克隆里**自带**看门人代码（bin/src 拷进去、node_modules 用 junction 借真仓库的），
 * 它自己就是共用检出、它的 origin 就是合成裸仓库——selfCheck 比的是「它自己」和「relay-run」。
 * different=true 时往 origin/main 再推一笔改了 src 的提交：relay-run 建出来就和它自己不一样。
 */
/**
 * 条件 2–4 的场：另建一个 `shared` 当「共用检出」（看门人从它起：REPO_ROOT、origin 都在它那儿），
 * 角色 cwd 还是 makeWorld 给的 integ/dev（配置不许 cwd 落在共用检出里）。
 * `shared` 里带 relay 代码（bin/src 拷进去、node_modules 用 junction 借真仓库的），它推上去的就是 origin/main。
 * match=false 时再往 origin/main 推一笔改过 src 的提交：relay-run 建出来就和 `shared` 自己不一样。
 */
function synthWorld(match: boolean): { w: World; shared: string } {
  const w = makeWorld({ status: '待领', idleSeconds: 1 });
  worlds.push(w);
  const shared = join(w.root, 'shared');
  w.git(w.root, ['clone', '-q', w.origin, shared]);
  w.git(shared, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(shared, '.git', 'info', 'exclude'), 'node_modules/\n', 'utf8');
  copyRelayTree(shared);
  w.git(shared, ['add', '-A']);
  w.git(shared, ['commit', '-q', '-m', '同步 relay 代码']);
  w.git(shared, ['push', '-q', 'origin', 'HEAD:main']);
  if (!match) {
    const other = join(w.root, 'other');
    w.git(w.root, ['clone', '-q', w.origin, other]);
    w.git(other, ['config', 'core.autocrlf', 'false']);
    const f = join(other, 'packages', 'relay', 'src', 'selfupdate.ts');
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n// origin 上多的一笔\n`, 'utf8');
    w.git(other, ['add', '-A']);
    w.git(other, ['commit', '-q', '-m', 'origin 上的新代码']);
    w.git(other, ['push', '-q', 'origin', 'HEAD:main']);
  }
  symlinkSync(join(REPO, 'node_modules'), join(shared, 'node_modules'), 'junction');
  // 预建 relay-run（看门人那一轮只需 switch 一下），node_modules 现成（起 once 要用）
  const run = join(w.root, 'trees', 'relay-run');
  w.git(shared, ['worktree', 'add', '--detach', run, 'origin/main']);
  symlinkSync(join(REPO, 'node_modules'), join(run, 'node_modules'), 'junction');
  return { w, shared };
}

/** 起看门人：直接起 shared 里那份 relay.mjs（cwd 也是它）——REPO_ROOT、共用检出、origin 全在合成世界。 */
async function runWatchdog(
  syn: { w: World; shared: string },
  opts: { forever?: boolean },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { w, shared } = syn;
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      IXAEON_RELAY_DIR: w.dataDir,
      IXAEON_WORKTREES: join(w.root, 'trees'),
    };
    if (opts.forever) env.IXAEON_RELAY_FOREVER = '1';
    delete env.IXAEON_RELAY_CODE;
    delete env.IXAEON_RELAY_NOW;
    // 复审整改（Codex 第 4 条）：条件 4 要的是「没设 forever」；跑测试的这台机器要是本身就设了
    // IXAEON_RELAY_FOREVER=1，不删掉的话条件 4 实际还在走 forever 那条路（会错误地退 75）。
    if (!opts.forever) delete env.IXAEON_RELAY_FOREVER;
    const p = spawn(
      process.execPath,
      [join(shared, 'packages', 'relay', 'bin', 'relay.mjs'), 'run', '--exit-when-idle'],
      {
        cwd: shared,
        env,
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
      p.kill();
    }, 90_000);
    p.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}
describe('条件 2–4：看门人自比代码', () => {
  it('条件 2：forever 底下、代码不一样 → 退 75、没起 once、锁放掉了', async () => {
    const syn = synthWorld(false);
    const { w } = syn;
    const r = await runWatchdog(syn, { forever: true });
    expect(r.status, r.stdout + r.stderr).toBe(RESTART_EXIT_CODE);
    expect(r.stdout).toContain('看门人自己的代码换了');
    expect(w.ledger()).toEqual([]);
    expect(existsSync(join(w.dataDir, 'lock.json'))).toBe(false);
  }, 120_000);

  it('条件 3：代码一样 → 照常起棒，不以 75 退', async () => {
    const syn = synthWorld(true);
    const { w } = syn;
    const r = await runWatchdog(syn, { forever: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('看门人自己的代码换了');
    expect(w.ledger().length).toBeGreaterThan(0);
    expect(existsSync(join(w.dataDir, 'lock.json'))).toBe(false);
  }, 180_000);

  it('条件 4：没设 forever → 代码不一样也照常起棒（行为不变）', async () => {
    const syn = synthWorld(false);
    const { w } = syn;
    const r = await runWatchdog(syn, {});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('看门人自己的代码换了');
    expect(w.ledger().length).toBeGreaterThan(0);
  }, 120_000);
});
/** `relay forever` 的替身入口：按 calls 文件里的第 N 次给退出码；记参数和环境。 */
function fakeEntry(dir: string, codes: number[]): { entry: string; callsFile: string } {
  const entry = join(dir, 'packages', 'relay', 'bin', 'relay.mjs');
  mkdirSync(join(dir, 'packages', 'relay', 'bin'), { recursive: true });
  const callsFile = join(dir, 'calls.jsonl');
  writeFileSync(
    entry,
    [
      "import { appendFileSync } from 'node:fs';",
      'const codes = ' + JSON.stringify(codes) + ';',
      'const callsFile = ' + JSON.stringify(callsFile) + ';',
      "appendFileSync(callsFile, JSON.stringify({ argv: process.argv.slice(2), forever: process.env.IXAEON_RELAY_FOREVER ?? null, pid: process.pid }) + '\\n', 'utf8');",
      'const n = (await import("node:fs")).readFileSync(callsFile, "utf8").trim().split("\\n").length - 1;',
      'process.exit(codes[n] ?? codes[codes.length - 1] ?? 0);',
      '',
    ].join('\n'),
    'utf8',
  );
  return { entry, callsFile };
}

async function runForever(
  w: World,
  codeDir: string,
  args: string[] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [CLI, 'forever', ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        IXAEON_WORKTREES: join(w.root, 'trees'),
        IXAEON_RELAY_CODE: codeDir,
      } as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => p.kill(), 100_000);
    p.on('close', (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

const callsOf = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv: string[]; forever: string | null; pid: number })
    : [];

describe('条件 5–7：relay forever', () => {
  it('条件 5：替身 75、75、4 → 退 4；被起 3 次；参数与环境对；「重起」正好 2 行', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    const fake = temp('ixa-l18-fake-');
    const { callsFile } = fakeEntry(fake, [75, 75, 4]);
    const r = await runForever(w, fake, ['--exit-when-idle']);
    expect(r.status, r.stdout + r.stderr).toBe(4);
    const calls = callsOf(callsFile);
    expect(calls).toHaveLength(3);
    expect(
      calls.every((c) => JSON.stringify(c.argv) === JSON.stringify(['run', '--exit-when-idle'])),
    ).toBe(true);
    expect(calls.every((c) => c.forever === '1')).toBe(true);
    expect(
      r.stdout.split('\n').filter((l) => l.includes('relay run 的代码换了，重起')).length,
    ).toBe(2);
  }, 150_000);

  it('条件 6：替身一直退 75 → 退 1、含「重起了 6 次，停下」、被起 6 次', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    const fake = temp('ixa-l18-fake-');
    const { callsFile } = fakeEntry(fake, [75]);
    const r = await runForever(w, fake);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('重起了 6 次，停下');
    expect(callsOf(callsFile)).toHaveLength(6);
  }, 150_000);

  it('条件 7：替身退 0 → 退 0、只起 1 次', async () => {
    const w = makeWorld({ status: '待领', idleSeconds: 1 });
    worlds.push(w);
    const fake = temp('ixa-l18-fake-');
    const { callsFile } = fakeEntry(fake, [0]);
    const r = await runForever(w, fake);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(callsOf(callsFile)).toHaveLength(1);
  }, 150_000);
});
