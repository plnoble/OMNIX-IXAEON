/**
 * L9 真机检查「甲」：真 Claude 当整合方跑一棒规划棒（真调用 1 次）。
 *
 * 在**临时目录**里建一个合成的 git 仓库：bare origin + 整合方/开发各一个克隆。
 * 里面放合成的 `docs/三周任务单.md`（两件已经写明的活、一件写在「明确不做」里）和全是「已完成」的合成队列，
 * 再从本仓库复制 `docs/委派/整合方手册.md` 和 `AGENTS.md`。整合方的命令行是 `relay init` 生成的那条真 Claude
 * 命令（cwd 改成临时克隆）；数据目录用临时目录、不配飞书。
 *
 * 跑一次 `relay once`，打印：输出的那一行、加了几行、`git diff --stat`、核对结果、
 * 「明确不做」的那件有没有被排进去、这一棒花了多少钱。
 * 临时目录跑完删掉；打印的路径与本机账户名都遮掉。
 *
 * 不用「跳过所有权限」的开关。不看、不打印凭据文件。
 *   node scripts/real/l9-plan-turn.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(repo, 'packages', 'relay', 'bin', 'relay.mjs');
const work = mkdtempSync(join(tmpdir(), 'ixa-l9-plan-'));
const trees = join(work, 'trees');
const mask = (s) => {
  let text = String(s);
  for (const p of [
    work,
    trees,
    process.env.TEMP,
    process.env.TMP,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    homedir(),
    tmpdir(),
  ].filter((x) => x && x.trim())) {
    for (const v of [p, p.replaceAll('\\', '/'), JSON.stringify(p).slice(1, -1)]) {
      text = text.split(v).join('<临时目录>');
    }
  }
  for (const n of [process.env.USERNAME, process.env.USER]) {
    if (n && n.trim().length >= 3) text = text.split(n.trim()).join('<本机账户>');
  }
  return text;
};
const log = (...a) => console.log(...a.map((v) => (typeof v === 'string' ? mask(v) : v)));

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(mask(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`));
  return (r.stdout ?? '').trim();
};

const claudeExe = join(
  process.env.APPDATA ?? '',
  'npm',
  'node_modules',
  '@anthropic-ai',
  'claude-code',
  'bin',
  'claude.exe',
);
if (!existsSync(claudeExe)) {
  log('没跑：没找到 claude.exe');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const TASK_A = 'L90 合成：把甲这件事做完（三周任务单已经写明下一步）';
const TASK_B = 'L91 合成：把乙这件事做完（三周任务单已经写明下一步）';
const TASK_NO = 'L99 合成：这件事明确不做，不要排进队列';

const QUEUE = [
  '# 委派队列（合成的）',
  '',
  '## 可以领的',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  '| 70 | L70 合成：早就做完的一行 | [L70](L70.md) | A | 无 | 已完成（2026-10-22） |',
  '',
  '## 已完成',
  '',
  '| 序号 | 任务 | 档位 | 结果 |',
  '| ---- | ---- | ---- | ---- |',
  '| 1 | 以前的合成任务 | A | 2026-10-22 并入 |',
  '',
].join('\n');

const TASKS = [
  '# 三周任务单（合成的）',
  '',
  '## 接下来做',
  '',
  `1. **${TASK_A}**：下一步已经写明，直接排进队列、写一页规格。`,
  `2. **${TASK_B}**：下一步已经写明，直接排进队列、写一页规格。`,
  '',
  '## 明确不做',
  '',
  `- **${TASK_NO}**。`,
  '',
  '## 暂停的能力',
  '',
  '- Door、模型池、自我升级、多设备、角色治理。',
  '',
].join('\n');

const root = work;
const origin = join(root, 'origin.git');
const seed = join(root, 'seed');
const integ = join(root, 'integ');
const dev = join(root, 'dev');
const dataDir = join(root, 'relay');
mkdirSync(join(dataDir, 'turns'), { recursive: true });
mkdirSync(trees, { recursive: true });

git(root, ['init', '--bare', '-b', 'main', origin]);
git(root, ['clone', '-q', origin, seed]);
git(seed, ['config', 'user.email', 'relay@example.invalid']);
git(seed, ['config', 'user.name', 'relay']);
mkdirSync(join(seed, 'docs', '委派'), { recursive: true });
writeFileSync(join(seed, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
writeFileSync(join(seed, 'docs', '三周任务单.md'), TASKS, 'utf8');
for (const f of ['AGENTS.md', join('docs', '委派', '整合方手册.md')]) {
  writeFileSync(join(seed, f), readFileSync(join(repo, f), 'utf8'), 'utf8');
}
writeFileSync(join(seed, 'docs', '委派', '锁定验收.json'), '{"tasks":[]}\n', 'utf8');
git(seed, ['add', '-A']);
git(seed, ['commit', '-q', '-m', '初始合成仓库']);
git(seed, ['push', '-q', 'origin', 'HEAD:main']);
const base = git(origin, ['rev-parse', 'main']);
for (const d of [integ, dev]) {
  git(root, ['clone', '-q', origin, d]);
  git(d, ['config', 'user.email', 'relay@example.invalid']);
  git(d, ['config', 'user.name', 'relay']);
}

/** 开发替身：规划棒轮不到开发，什么都不做。 */
const stub = join(root, 'stub-dev.mjs');
writeFileSync(stub, 'console.log("RELAY-DONE 70 不关我的事");\n', 'utf8');

let bad = 0;
const check = (ok, what, extra = '') => {
  if (!ok) bad++;
  log(`  ${ok ? '✓' : '✗'} ${what}${extra ? `：${mask(extra)}` : ''}`);
};

/** 主表里每一行的六格原样（只认第一张主表）。 */
const mainRows = (md) => {
  const lines = md.split(/\r?\n/);
  const cellsOf = (line) =>
    line.trim().startsWith('|')
      ? line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim())
      : null;
  const head = lines.findIndex((l) => {
    const c = cellsOf(l);
    return (
      c && ['序号', '任务', '委派单或规格', '档位', '依赖', '状态'].every((h) => c.includes(h))
    );
  });
  if (head < 0) return [];
  const rows = [];
  for (let i = head + 1; i < lines.length; i++) {
    const c = cellsOf(lines[i]);
    if (!c) break;
    if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue;
    rows.push(c);
  }
  return rows;
};

const ledger = (dir) => {
  const p = join(dir, 'ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

try {
  // 一、先用 `relay init` 生成真 Claude 那条命令行（临时工作目录根，收尾时从仓库摘掉）。
  log('== 一、relay init 生成配置（临时数据目录 / 临时工作目录根）');
  const init = spawnSync(process.execPath, [CLI, 'init'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      IXAEON_RELAY_DIR: dataDir,
      IXAEON_WORKTREES: trees,
    },
    windowsHide: true,
    timeout: 180_000,
  });
  log(`   init 退出码 ${init.status}`);
  log(`   ${mask((init.stdout ?? '').trim())}`);
  if ((init.stderr ?? '').trim())
    log(`   stderr：${mask((init.stderr ?? '').trim()).slice(0, 300)}`);
  check(init.status === 0, 'relay init 生成了配置');
  check(existsSync(join(dataDir, 'config.json')), '临时数据目录里有 config.json');

  if (!existsSync(join(dataDir, 'config.json'))) throw new Error('relay init 没写出配置');

  const generated = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  log(`   生成的整合方命令行（遮掉路径）：${mask(generated.roles.integrator.argv.join(' '))}`);
  check(
    generated.roles.integrator.argv[0] === claudeExe,
    '整合方的命令行用的是这台机器上的真 Claude',
  );

  // 二、改成这次真机检查的形状：整合方 cwd 是临时克隆，开发是替身，规划有额度、不配飞书。
  generated.roles.integrator.cwd = integ;
  generated.roles.integrator.timeoutMinutes = 20;
  generated.roles.developer.argv = [process.execPath, stub, '{prompt_file}'];
  generated.roles.developer.cwd = dev;
  generated.localUserCheck = [process.execPath, '-e', 'process.exit(0)'];
  generated.idleSeconds = 1;
  generated.planPerDay = 2;
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(generated, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(dataDir, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 }, null, 2)}\n`,
    'utf8',
  );

  // 三、真跑一棒规划棒。
  log('== 二、真 Claude 跑一棒规划棒（relay once）');
  const r = spawnSync(process.execPath, [CLI, 'once'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      IXAEON_RELAY_DIR: dataDir,
      IXAEON_RELAY_NOW: '2026-10-23T02:00:00.000Z',
      IXAEON_WORKTREES: trees,
    },
    windowsHide: true,
    timeout: 1_500_000,
  });
  log(`   relay once 退出码 ${r.status}`);
  log(`   输出的那一行：${mask((r.stdout ?? '').trim())}`);
  if ((r.stderr ?? '').trim()) log(`   stderr：${mask((r.stderr ?? '').trim()).slice(0, 400)}`);
  check(r.status === 0, 'relay once 退出码 0');

  // 四、origin/main 上加了什么。
  git(integ, ['pull', '--ff-only', '-q', 'origin', 'main']);
  const afterQueue = git(integ, ['show', 'origin/main:docs/委派/队列.md']);
  const before = mainRows(QUEUE);
  const after = mainRows(afterQueue);
  const added = after.filter((row) => !before.some((b) => b.join('\u0000') === row.join('\u0000')));
  log(`   加了几行：${added.length}`);
  for (const row of added) log(`   新行：第 ${row[0]} 行｜${row[1]}｜${row[5]}`);
  log(`   git diff --stat（初始提交..origin/main）：`);
  for (const line of git(integ, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--stat',
    `${base}..origin/main`,
  ]).split('\n')) {
    log(`     ${line}`);
  }
  const changedFiles = git(integ, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    `${base}..origin/main`,
  ])
    .split('\n')
    .filter(Boolean);
  log(`   改动文件：${changedFiles.join('、')}`);

  const rows = ledger(dataDir);
  const turn = rows[0];
  log(`   记账：${turn ? JSON.stringify({ ...turn, usage: turn.usage }) : '(没有)'}`);
  const solvedNo = added.some((row) => row[1].includes('L99') || row[1].includes('明确不做'));
  const solvedA = added.some((row) => row[1].includes('L90'));
  const solvedB = added.some((row) => row[1].includes('L91'));
  const cost =
    typeof turn?.usage?.costUsd === 'number'
      ? turn.usage.costUsd
      : (() => {
          try {
            const stdout = readFileSync(join(dataDir, 'turns', '1', 'stdout.txt'), 'utf8').trim();
            return JSON.parse(stdout).total_cost_usd;
          } catch {
            return null;
          }
        })();
  log(`   这一棒花了多少钱：${typeof cost === 'number' ? `${cost} 美元` : '没记上'}`);
  log(`   核对结果：${turn ? JSON.stringify(turn.violations) : '(没有记账)'}`);
  log(`   「明确不做」的那件排进去了吗：${solvedNo ? '排进去了（不对）' : '没有（对）'}`);

  check(rows.length === 1, '只跑了一棒（记了一行账）', String(rows.length));
  check(
    turn?.kind === 'integrator-plan' && turn?.taskId === 'plan',
    '记账是规划棒（kind / taskId）',
  );
  check(
    turn?.statusBefore === 'queue-empty',
    'statusBefore 是 queue-empty',
    String(turn?.statusBefore),
  );
  check(
    /^加了 \d+ 行$/.test(String(turn?.statusAfter)),
    'statusAfter 是「加了 N 行」',
    String(turn?.statusAfter),
  );
  check(added.length >= 1 && added.length <= 3, '加的行数在 1–3 之间', String(added.length));
  check(!solvedNo, '没有把「明确不做」的那件排进去');
  log(
    `   三周任务单里那两件排了吗：L90 ${solvedA ? '排了' : '没排'}、L91 ${solvedB ? '排了' : '没排'}`,
  );
  check(
    added.every((row) => row[5].startsWith('待领') || row[5].startsWith('等用户：')),
    '新加的行状态都是「待领」或「等用户：」',
  );
  check(
    changedFiles.every((f) => f.startsWith('docs/')),
    '只改了 docs/ 下面的文件',
    changedFiles.join('、'),
  );
  check(
    !!turn && Array.isArray(turn.violations) && turn.violations.length === 0,
    '核对没有越界',
    JSON.stringify(turn?.violations ?? []),
  );
  check(typeof cost === 'number' && cost > 0, '这一棒花了钱（usage 记上了）');
} catch (err) {
  bad++;
  log(`  ✗ 出错：${mask(err instanceof Error ? err.message : String(err))}`);
} finally {
  // 生成配置时建的工作目录是从真仓库摘的，先摘掉再删临时目录。
  spawnSync('git', ['worktree', 'remove', '--force', join(trees, 'relay-int')], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
  spawnSync('git', ['worktree', 'prune'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  rmSync(work, { recursive: true, force: true });
}

log(bad === 0 ? 'RESULT 通过' : `RESULT 没通过（${bad} 条）`);
process.exit(bad === 0 ? 0 : 1);
