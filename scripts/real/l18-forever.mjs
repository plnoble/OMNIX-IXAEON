/**
 * L18 真机检查（委派单 docs/委派/L18-看门人换了代码自己重起.md「真机检查」）。
 *
 * 照 scripts/real/l10-watchdog.mjs：临时裸仓库当 origin、IXAEON_WORKTREES 指到临时目录、
 * 角色用替身，**不碰用户真实的 relay-run 和数据目录**。
 *
 * 做法：合成世界（shared 当共用检出，带真 relay 代码）里起 `relay forever --exit-when-idle`；
 * 第一轮跑完一棒后，往合成 origin/main 推一笔只改 `packages/relay/src/` 里一行注释的提交；
 * 核对：输出里先有「看门人自己的代码换了」、再有「relay run 的代码换了，重起」，
 * 第二个看门人的进程号和第一个不一样，最后退 0。每步不符打「结论：不通过」退 1。
 * 另外记一句：relay-run 里正跑着的看门人自己换 relay-run 的依赖，在 Windows 上有没有撞上文件被占。
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
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = mkdtempSync(join(tmpdir(), 'ixa-l18-real-'));
/**
 * 遮掉临时目录与账户名。复审整改（Codex 第 2 轮第 3 条）：只遮反斜杠那种形式不够——
 * Node 的错误栈里是 `file:///C:/Users/<账户名>/…`（正斜杠 + file URL），子进程输出原样转发时
 * 会把账户名带出来。所以每个路径都按「反斜杠 / 正斜杠 / file URL」三种写法各遮一遍。
 */
function variantsOf(p) {
  const fwd = p.replaceAll('\\', '/');
  const withSlash = fwd.startsWith('/') ? fwd : `/${fwd}`;
  return [p, fwd, `file://${withSlash}`];
}
const masks = [...new Set([...variantsOf(work), ...variantsOf(homedir())].filter(Boolean))].sort(
  (a, b) => b.length - a.length,
);
const mask = (s) => {
  let text = String(s);
  for (const m of masks) text = text.split(m).join('<本机>');
  return text;
};
const log = (...a) => console.log(...a.map(mask));

let passed = false;
const fails = [];
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) fails.push(what);
  return ok;
};

try {
  const origin = join(work, 'origin.git');
  const shared = join(work, 'shared');
  const dataDir = join(work, 'relay');
  const trees = join(work, 'trees');
  mkdirSync(dataDir, { recursive: true });
  const g = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
    return (r.stdout ?? '').trim();
  };
  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { windowsHide: true });
  spawnSync('git', ['clone', '-q', origin, shared], { windowsHide: true });
  g(shared, 'config', 'user.email', 'relay@example.invalid');
  g(shared, 'config', 'user.name', 'relay');
  g(shared, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(shared, '.git', 'info', 'exclude'), 'node_modules/\n', 'utf8');
  // 合成队列（一行待领，替身角色会把它改成测试待审）+ 看门人真代码
  mkdirSync(join(shared, 'docs', '委派'), { recursive: true });
  writeFileSync(
    join(shared, 'docs', '委派', '队列.md'),
    [
      '# 委派队列',
      '',
      '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
      '| ---- | ---- | ------------ | ---- | ---- | ---- |',
      '| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | 待领 |',
      '| 71 | L9 合成的另一行 | [L9](L9.md) | B | 无 | 待领 |',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(shared, 'docs', '委派', '锁定验收.json'), '{"tasks":[]}\n', 'utf8');
  spawnSync(
    'robocopy',
    [
      join(REPO, 'packages', 'relay'),
      join(shared, 'packages', 'relay'),
      '/E',
      '/NFL',
      '/NDL',
      '/NJH',
      '/NJS',
    ],
    { windowsHide: true },
  );
  g(shared, 'add', '-A');
  g(shared, 'commit', '-q', '-m', '初始合成仓库（带 relay 代码）');
  g(shared, 'push', '-q', 'origin', 'HEAD:main');
  symlinkSync(join(REPO, 'node_modules'), join(shared, 'node_modules'), 'junction');
  // 预建 relay-run，并给角色替身
  const run = join(trees, 'relay-run');
  g(shared, 'worktree', 'add', '--detach', run, 'origin/main');
  symlinkSync(join(REPO, 'node_modules'), join(run, 'node_modules'), 'junction');
  // 角色的 cwd 不能是共用检出（checkConfig 拦）：另给它一个克隆
  const roleclone = join(work, 'roleclone');
  g(work, 'clone', '-q', origin, roleclone);
  spawnSync('git', ['clone', '-q', origin, roleclone], { windowsHide: true });
  g(roleclone, 'config', 'user.email', 'relay@example.invalid');
  g(roleclone, 'config', 'user.name', 'relay');
  g(roleclone, 'config', 'core.autocrlf', 'false');
  const stub = join(work, 'stub.mjs');
  writeFileSync(
    stub,
    [
      "import { spawnSync } from 'node:child_process';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const clone = process.argv[process.argv.indexOf("--clone") + 1];',
      'const g = (...a) => { const r = spawnSync("git", a, { cwd: clone, encoding: "utf8" }); if (r.status !== 0) process.exit(1); return r.stdout; };',
      'g("fetch", "-q", "origin"); g("reset", "-q", "--hard", "origin/main");',
      'const q = clone + "/docs/委派/队列.md";',
      'const lines = readFileSync(q, "utf8").split("\\n");',
      'const i = lines.findIndex((l) => l.includes("| 待领 |"));',
      '// 每轮只做一行：第一轮做 70，第二轮做 71',
      'if (i >= 0) { lines[i] = lines[i].replace("| 待领 |", "| 已完成（2026-10-25） |"); writeFileSync(q, lines.join("\\n"), "utf8"); g("add", "-A"); g("commit", "-q", "-m", "合成：替身把这一行做完"); g("push", "-q", "origin", "HEAD:main"); console.log("RELAY-DONE 70 已完成"); process.exit(0); }',
      'console.log("RELAY-DONE 没活");',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'config.json'),
    `${JSON.stringify(
      {
        roles: {
          integrator: {
            argv: [process.execPath, stub, '{prompt_file}', '--clone', roleclone],
            cwd: roleclone,
            timeoutMinutes: 3,
            quotaPatterns: ['usage_limit_reached'],
            quotaPauseMinutes: 30,
          },
          developer: {
            argv: [process.execPath, stub, '{prompt_file}', '--clone', roleclone],
            cwd: roleclone,
            timeoutMinutes: 3,
            quotaPatterns: ['usage_limit_reached'],
            quotaPauseMinutes: 30,
          },
        },
        idleSeconds: 2,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 })}\n`,
    'utf8',
  );

  log('== 起 relay forever（合成 origin，角色替身）');
  const p = spawn(
    process.execPath,
    [join(shared, 'packages', 'relay', 'bin', 'relay.mjs'), 'forever', '--exit-when-idle'],
    {
      cwd: shared,
      env: {
        ...process.env,
        IXAEON_RELAY_DIR: dataDir,
        IXAEON_WORKTREES: trees,
        // 复审整改（Codex 第 2 轮第 2 条）：这台机器要是有 IXAEON_RELAY_CODE，forever 会去起它
        // 指的那份入口、还禁用了自检，合成世界就被绕过去了。真机检查必须清掉它。
        IXAEON_RELAY_CODE: '',
      },
      windowsHide: true,
    },
  );
  let out = '';
  let pushed = false;
  /**
   * 复审整改（Codex 第 2 条）：规格要求「第一轮跑完一棒后」再推，不是看到 pid 就推——
   * 那样可能在第一棒还没跑的时候就已经重起了，等于没验到「跑完一棒再重起」。
   * 判据用记账文件：有了一行，才说明第一棒真跑完了。输出里也看到「第 N 棒」再推，双重保险。
   */
  const firstTurnDone = () => {
    try {
      return (
        readFileSync(join(dataDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length > 0
      );
    } catch {
      return false;
    }
  };
  const pushChange = async () => {
    if (pushed) return;
    if (!firstTurnDone()) return;
    if (!/看门人 \d+/.test(out)) return;
    pushed = true;
    try {
      const edit = join(work, 'edit');
      spawnSync('git', ['clone', '-q', origin, edit], { windowsHide: true });
      g(edit, 'config', 'user.email', 'relay@example.invalid');
      g(edit, 'config', 'user.name', 'relay');
      g(edit, 'config', 'core.autocrlf', 'false');
      const f = join(edit, 'packages', 'relay', 'src', 'selfupdate.ts');
      writeFileSync(f, `${readFileSync(f, 'utf8')}\n// 真机检查：只改一行注释\n`, 'utf8');
      g(edit, 'add', '-A');
      g(edit, 'commit', '-q', '-m', '真机检查：改一行注释');
      g(edit, 'push', '-q', 'origin', 'HEAD:main');
      log('   （已往合成 origin/main 推一笔只改 src 的提交）');
      rmSync(edit, { recursive: true, force: true });
    } catch (err) {
      log(`   推那笔提交失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // 复审整改（Codex 第 3 条）：子进程输出也要过 mask——git、装依赖出错时会带出含账户名的临时路径。
  p.stdout.on('data', (d) => {
    const s = d.toString('utf8');
    out += s;
    process.stdout.write(mask(s));
    pushChange();
  });
  p.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    out += s;
    process.stderr.write(mask(s));
  });
  const code = await new Promise((done) => {
    const t = setTimeout(() => {
      spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
      done('timeout');
    }, 420_000);
    p.on('close', (c) => {
      clearTimeout(t);
      done(c);
    });
  });

  log('== 核对');
  const firstPid = /看门人 (\d+)/.exec(out)?.[1];
  const pids = [...out.matchAll(/看门人 (\d+)/g)].map((m) => m[1]);
  const secondPid = pids.length > 1 ? pids[1] : null;
  check(code === 0, `relay forever 最后退 0（实际 ${String(code)}）`);
  check(out.includes('看门人自己的代码换了'), '输出里有「看门人自己的代码换了」');
  check(out.includes('relay run 的代码换了，重起'), '输出里有「relay run 的代码换了，重起」');
  const a = out.indexOf('看门人自己的代码换了');
  const b = out.indexOf('relay run 的代码换了，重起');
  check(a >= 0 && b > a, '「代码换了」在前，「重起」在后');
  check(
    pids.length >= 2 && firstPid !== secondPid,
    `第二个看门人的进程号和第一个不一样（${firstPid} → ${secondPid ?? '无'}）`,
  );
  check(existsSync(join(run, 'packages', 'relay', 'bin', 'relay.mjs')), 'relay-run 里那份代码在');
  // Windows 上「自己换自己的依赖」有没有撞上文件被占（规格要求如实记一句）
  const lockNote = /EPERM|EBUSY|拒绝访问|Access is denied|另一进程/.test(out)
    ? '收输出里看到了文件被占/拒绝访问的字样（见上面原样输出）'
    : '收输出里没看到文件被占/拒绝访问的字样';
  log(`== ensureDeps 撞文件占用情况：${lockNote}`);
  passed = fails.length === 0;
} catch (err) {
  log('脚本出错：', err instanceof Error ? err.message : String(err));
} finally {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(join(work, 'trees'), { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
log(passed ? '结论：通过' : `结论：不通过（${fails.join('；') || '见上'}）`);
process.exitCode = passed ? 0 : 1;
