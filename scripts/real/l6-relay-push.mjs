/**
 * L6 真机检查乙：真 DSH + 调度器替推（实现后跑；DSH 真调用 1 次）。
 *
 * 临时目录里造一个裸仓库当 origin、一份「调度器所在仓库」的克隆、开发用它的工作目录，合成队列一行
 * 「待领」。开发用**真 DSH**（`pushByRelay: true`），整合方用替身；跑一次 `relay once`。看三件事：
 * DSH 有没有照交代只提交、写出 `RELAY-PUSH`；调度器有没有替它推上去；记账里的 `pushes`。
 *
 * 全程不连 GitHub（origin 是本地裸仓库）、不调模型、不推送任何公开仓库；临时目录收尾删掉。
 *   node scripts/real/l6-relay-push.mjs
 *
 * **已知取舍（2026-10-23 实测后写的）**：开发的工作目录这里用**独立克隆**（`.git` 在自己目录里），
 * 因为 DSH 的沙箱只许写自己的工作目录——`git worktree` 的 `.git` 在外面，它提交不了（实测原话：
 * 「等用户：是否切到完全权限以便提交（git 目录在工作区外，沙箱拒绝写入）」）。代价是：契约第 4 条那道
 * 「`dir` 是调度器所在仓库的工作目录」在真机上就过不了（克隆不是同一个仓库），所以**真机上跑到「调度器
 * 替推成功」这一步要另想形状**（比如让调度器把开发的克隆当自己仓库、或者给部署留一个出口）。
 * 调度器这一侧的替推逻辑本身由 9 条锁定测试覆盖。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const RELAY_MAIN = join(REPO, 'packages', 'relay', 'bin', 'relay-main.ts');
const root = mkdtempSync(join(tmpdir(), 'ixa-l6b-push-'));
const origin = join(root, 'origin.git');
const sched = join(root, 'sched');
// L6b：开发的工作目录根是 <根>/dsh，它自己的克隆在 <根>/dsh/repo（`.git` 在里面）。
const devRoot = join(root, 'dsh');
const devRepo = join(devRoot, 'repo');
const integ = join(root, 'integ');
const dataDir = join(root, 'relay');

const mask = (s) => {
  let text = String(s);
  for (const p of [root, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(v).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  text = text.replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '<令牌>');
  text = text.replace(/(token|secret|password)["'\s:=]{1,4}[^\s"',]{8,}/gi, '$1=<敏感值>');
  text = text.replace(/\/\/[^/\s@]+@/g, '//***@');
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};

/** DSH 的安装目录（照 bin/dsh.mjs 的找法）。 */
function findDsh() {
  const installs = [
    process.env.IXAEON_DSH_INSTALL?.trim(),
    'D:/Agent/DeepSeek Harness/Install',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'),
  ].filter((x) => x && x.trim());
  for (const install of installs) {
    const exe = join(install, 'DeepSeek Harness.exe');
    const asar = join(install, 'resources', 'app.asar');
    if (existsSync(exe) && existsSync(asar)) {
      return {
        exe,
        cli: join(
          install,
          'resources',
          'app.asar',
          'dsh',
          'node_modules',
          '@deepseek-ai',
          'dsh-desktop-host',
          'lib',
          'cli.js',
        ),
      };
    }
  }
  return null;
}

const jiti = (() => {
  const pnpm = join(REPO, 'node_modules', '.pnpm');
  const candidates = [];
  try {
    for (const d of readdirSync(pnpm)) {
      if (d.startsWith('jiti@')) {
        candidates.push(join(pnpm, d, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
      }
    }
  } catch {
    /* 没有 .pnpm */
  }
  candidates.push(join(REPO, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs'));
  return candidates.find((p) => existsSync(p));
})();

const dsh = findDsh();
if (!dsh || !jiti) {
  log(`没跑：${!dsh ? '没找到 DSH 的安装目录' : '没找到 jiti 的 CLI'}`);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

log('== 乙：真 DSH + 调度器替推（origin 是本地裸仓库，不连 GitHub）');

// 1) 合成仓库：裸 origin → seed 推一笔 → sched 克隆（调度器所在仓库）→ 开发的工作目录
git(root, ['init', '--bare', '-b', 'main', origin]);
const seed = join(root, 'seed');
git(root, ['clone', origin, seed]);
git(seed, ['config', 'user.email', 'relay@example.invalid']);
git(seed, ['config', 'user.name', 'relay']);
mkdirSync(join(seed, 'docs', '委派'), { recursive: true });
writeFileSync(
  join(seed, 'docs', '委派', '队列.md'),
  [
    '# 委派队列',
    '',
    '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
    '| ---- | ---- | ------------ | ---- | ---- | ---- |',
    '| 70 | L7 合成的一行 | [L7](L7.md) | B | 无 | 待领 |',
    '',
  ].join('\n'),
  'utf8',
);
git(seed, ['add', '-A']);
git(seed, ['commit', '-q', '-m', '初始合成仓库']);
// 合成仓库也要有一份 AGENTS.md：真仓库里开发照它干活，这里没有它就等于让它猜（第一轮真跑就是这么空转的）。
writeFileSync(
  join(seed, 'AGENTS.md'),
  [
    '# 合成仓库的干活规矩（给这一棒用）',
    '',
    '这是一次合成的演练，仓库里只有 docs/委派/队列.md 这份队列。**你就在这个仓库里干活**',
    '（这个仓库就是你自己的那份克隆，`.git` 在里面）。这一棒只做队列里那一行：',
    '',
    '1. 把 `docs/委派/队列.md` 里第 70 行（任务 L7）的状态从「待领」改成「测试待审（整合方）」；',
    '2. `git add -A && git commit -m "领 70：合成的一行"`（**不要** `git push`）；',
    '3. 在最后一行之前写一行 `RELAY-PUSH <这个仓库的绝对路径> <当前分支> main`' +
      '（当前分支就是你刚提交的那个分支；推送由调度器替你做）；',
    '4. 最后一行输出 `RELAY-DONE 70 测试待审（整合方）`。',
    '',
    '做完就停，不要领别的、不要碰别的文件、不要建新的工作目录。',
    '',
  ].join('\n'),
  'utf8',
);
git(seed, ['add', '-A']);
git(seed, ['commit', '-q', '-m', '合成仓库的 AGENTS.md']);
git(seed, ['push', '-q', 'origin', 'HEAD:main']);
git(root, ['clone', origin, sched]);
git(sched, ['config', 'user.email', 'relay@example.invalid']);
git(sched, ['config', 'user.name', 'relay']);
git(root, ['clone', origin, integ]);
git(integ, ['config', 'user.email', 'relay@example.invalid']);
git(integ, ['config', 'user.name', 'relay']);
// L6b 的布局：开发的工作目录根是 <工作目录根>/dsh，里面一份**它自己的克隆** repo（`.git` 在它里面）。
// 上一轮实测：`git worktree` 的 `.git` 在工作目录外面，DSH 的沙箱写不了、提交不了。
const devBranch = 'dev/l7-synthetic';
mkdirSync(devRoot, { recursive: true });
git(root, ['clone', origin, devRepo]);
git(devRepo, ['config', 'user.email', 'relay@example.invalid']);
git(devRepo, ['config', 'user.name', 'relay']);
git(devRepo, ['switch', '-q', '-c', devBranch]);
// DSH 的 cwd 是 devRoot，仓库在 devRoot/repo：给它在 cwd 里也放一份「该干什么」的说明，
// 免得它只在 repo 里翻（合成演练的便利，不是产品行为）。
writeFileSync(
  join(devRoot, 'AGENTS.md'),
  [
    '# 这一棒在哪干活',
    '',
    `你的仓库是 ${devRepo}（在它里面 git add / commit）。规矩见 ${join(devRepo, 'AGENTS.md')}。`,
    '',
  ].join('\n'),
  'utf8',
);
log('   合成仓库建好：裸 origin + 调度器所在仓库 + 开发自己的克隆（.git 在 repo 里面）');

// 2) 配置：开发用真 DSH（pushByRelay: true），整合方用替身
const stub = join(root, 'stub-integ.mjs');
writeFileSync(stub, ['console.log("RELAY-DONE 70 测试待审（整合方）");', ''].join('\n'), 'utf8');
mkdirSync(dataDir, { recursive: true });
const role = (argv, cwd, pushByRelay) => ({
  argv,
  cwd,
  timeoutMinutes: 20,
  quotaPatterns: ['usage_limit_reached', 'rate_limit_exceeded', 'session limit'],
  quotaPauseMinutes: 120,
  ...(pushByRelay ? { pushByRelay: true } : {}),
});
writeFileSync(
  join(dataDir, 'config.json'),
  `${JSON.stringify(
    {
      roles: {
        integrator: role([process.execPath, stub, '{prompt_file}'], integ, false),
        developer: role(
          [
            process.execPath,
            // 用真启动器（L4 起就是它）：它找安装目录、设 IXAEON_WORKTREES、追加 GIT_CONFIG_PARAMETERS，
            // 这一单的契约第 1 条就靠它。
            join(REPO, 'packages', 'relay', 'bin', 'dsh.mjs'),
            '--profile',
            'headless',
            '--json',
            '读 {prompt_file}，照里面做。',
          ],
          devRoot,
          true,
        ),
      },
      idleSeconds: 1,
      localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
    },
    null,
    2,
  )}\n`,
  'utf8',
);
writeFileSync(
  join(dataDir, 'state.json'),
  `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 }, null, 2)}\n`,
  'utf8',
);

// 3) 跑一棒：调度器在合成仓库上跑（cwd=sched），数据目录指到临时目录
const beforeMain = git(origin, ['rev-parse', 'refs/heads/main']);
log(`   开棒前裸仓库 main = ${beforeMain.slice(0, 12)}`);
const started = Date.now();
const run = spawn(process.execPath, [jiti, RELAY_MAIN, 'once'], {
  cwd: sched,
  env: {
    ...process.env,
    IXAEON_RELAY_DIR: dataDir,
    IXAEON_RELAY_NOW: '2026-10-22T02:00:00.000Z',
  },
  windowsHide: true,
});
let stdout = '';
let stderr = '';
run.stdout.on('data', (d) => (stdout += d.toString('utf8')));
run.stderr.on('data', (d) => (stderr += d.toString('utf8')));
const code = await new Promise((r) => run.on('close', r));
log(`   relay once 退出码 ${code}｜用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
log(`   它说的：${mask(stdout.trim().split('\n').slice(0, 6).join(' / ')).slice(0, 600)}`);
if (stderr.trim()) log(`   错误输出（截 600）：${mask(stderr.trim()).slice(0, 600)}`);

// 4) DSH 那棒的原样输出（遮掉临时目录）——看它是不是只提交、写了 RELAY-PUSH
const turnDir = join(dataDir, 'turns', '1');
if (existsSync(turnDir)) {
  const out = readFileSync(join(turnDir, 'stdout.txt'), 'utf8');
  const err = existsSync(join(turnDir, 'stderr.txt'))
    ? readFileSync(join(turnDir, 'stderr.txt'), 'utf8')
    : '';
  // 原样留一份（也是遮过的）到 .logs/：出结论时按它核对，不靠猜
  const dumpDir = join(REPO, '.logs');
  mkdirSync(dumpDir, { recursive: true });
  writeFileSync(join(dumpDir, 'l6-turn-stdout.txt'), mask(out), 'utf8');
  writeFileSync(join(dumpDir, 'l6-turn-stderr.txt'), mask(err), 'utf8');
  writeFileSync(join(dumpDir, 'l6-turn-transcript.txt'), mask(`${out}\n${err}`), 'utf8');
  log(`   DSH 原样输出（${out.length} 字，遮掉临时目录，截 1200）：`);
  log(`   ${mask(out).slice(0, 1200)}`);
  if (err.trim()) log(`   DSH 错误输出（截 800）：${mask(err).slice(0, 800)}`);
  // 它写了 RELAY-PUSH 吗：DSH 的输出是 JSONL，RELAY-PUSH 行在 `final.text` 里（照 parseRoleOutput 的认法）
  const pushSeen = (() => {
    for (const raw of `${out}\n${err}`.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('{')) {
        try {
          const j = JSON.parse(line);
          const inner =
            typeof j.result === 'string'
              ? j.result
              : j.type === 'final' && typeof j.text === 'string'
                ? j.text
                : '';
          if (/^RELAY-PUSH\s/m.test(inner)) return true;
        } catch {
          /* 不是 JSON 就当普通文字 */
        }
      } else if (/^RELAY-PUSH\s/m.test(line)) return true;
    }
    return false;
  })();
  log(`   它写了 RELAY-PUSH：${pushSeen}｜RELAY-DONE：${/RELAY-DONE/.test(out)}`);
  // 额度字样两路都查（契约：出现就停下那一步，如实写）
  const quota = ['usage_limit_reached', 'rate_limit_exceeded', 'session limit'];
  const all = `${out}\n${err}`;
  const hit = quota.filter((p) => all.toLowerCase().includes(p));
  log(`   额度字样（两路都查）：${hit.length ? `出现了：${hit.join('、')}` : '没出现'}`);
  for (const p of hit) {
    const i = all.toLowerCase().indexOf(p);
    log(`     出现在：${mask(all.slice(Math.max(0, i - 180), i + 180).replace(/\s+/g, ' '))}`);
  }
} else {
  log('   没有 turns/1 这一棒（没开成）');
}

// 5) 裸仓库和记账
const branches = git(origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  .split('\n')
  .filter(Boolean);
const afterMain = git(origin, ['rev-parse', 'refs/heads/main']);
log(`   裸仓库分支：${branches.join('、')}`);
log(
  `   裸仓库 main：${beforeMain.slice(0, 12)} → ${afterMain.slice(0, 12)}（前进了=${beforeMain !== afterMain}）`,
);
log(
  `   开发那份克隆的分支：${git(devRepo, ['branch', '--format=%(refname:short)']).split('\n').join('、')}`,
);
log(
  `   开发那份克隆里 git status：${git(devRepo, ['status', '--porcelain=v1', '--branch']).replace(/\n/g, ' | ')}`,
);
const ledgerPath = join(dataDir, 'ledger.jsonl');
if (existsSync(ledgerPath)) {
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    log(
      `   记账：turn=${row.turn} role=${row.role} exit=${row.exitCode} 越界=${JSON.stringify(row.violations)}`,
    );
    log(`   记账 pushes：${JSON.stringify(row.pushes ?? null)}`);
    log(
      `   记账 statusAfter=${row.statusAfter}｜doneLine=${mask(String(row.doneLine ?? '')).slice(0, 120)}`,
    );
  }
} else {
  log('   没有记账');
}
log(
  `   state.json：${mask(readFileSync(join(dataDir, 'state.json'), 'utf8').replace(/\s+/g, ' '))}`,
);
log(
  `   额度字样：${/usage_limit_reached|rate_limit_exceeded|session_limit/i.test(stdout) ? '出现了' : '没出现'}`,
);

// 6) 收尾：删临时目录（开发那份是克隆，不是工作目录，不用摘）
rmSync(root, { recursive: true, force: true });
log(`   收尾：已删临时目录（${existsSync(root) ? '没删掉' : '删掉了'}）`);
process.exitCode = 0;
