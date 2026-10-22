/**
 * L2 真机检查「乙」：真的 Claude Code 当整合方跑一棒（真调用 1 次；改配置重跑最多再 1 次）。
 *
 * 临时裸仓库 + 整合方/开发各一个克隆，合成队列一行「测试待审（整合方）」，任务是合成的：
 * 「把这一行的状态改成已完成（合成）、提交、推送」。整合方用真 Claude（args 照 config.example.json：
 * --restricted、白名单、--permission-prompts none、--output-format json），开发用替身。
 *
 * `relay once` 之后检查：这一行在 origin/main 上变成已完成、doneLine 认出来了、usage.costUsd 记上了、
 * 临时目录以外什么都没写。打印记账那一行（遮掉临时目录与账户名）。
 *
 * 不用任何「跳过所有权限」的开关。不看、不打印凭据文件。
 *   node scripts/real/l2-claude-turn.mjs                 # 照 config.example.json
 *   node scripts/real/l2-claude-turn.mjs --add-dir       # 加 --add-dir <数据目录>、--tools 里带上 Write Edit
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(repo, 'packages', 'relay', 'bin', 'relay.mjs');
const withAddDir = process.argv.includes('--add-dir');
const work = mkdtempSync(join(tmpdir(), 'ixa-l2-claude-'));
const mask = (s) => {
  let text = String(s);
  for (const p of [work, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    for (const v of [p, p.replaceAll('\\', '/')]) text = text.split(v).join('<临时目录>');
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

const TASK = 'L70 把这一行的状态改成已完成（合成）、提交、推送';
const QUEUE = [
  '# 委派队列',
  '',
  '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
  '| ---- | ---- | ------------ | ---- | ---- | ---- |',
  `| 70 | ${TASK} | [L70](L70.md) | B | 无 | 测试待审（整合方） |`,
  '',
].join('\n');

const origin = join(work, 'origin.git');
const integ = join(work, 'integ');
const dev = join(work, 'dev');
const dataDir = join(work, 'relay');
mkdirSync(dataDir, { recursive: true });
git(work, ['init', '--bare', '-b', 'main', origin]);
git(work, ['clone', origin, integ]);
git(integ, ['config', 'user.email', 'relay@example.invalid']);
git(integ, ['config', 'user.name', 'relay']);
mkdirSync(join(integ, 'docs', '委派'), { recursive: true });
writeFileSync(join(integ, 'docs', '委派', '队列.md'), QUEUE, 'utf8');
writeFileSync(
  join(integ, 'AGENTS.md'),
  '# 合成仓库的规矩\n\n这是验证用的合成仓库。照这一棒的交代做：只改队列里那一行，提交、推送。\n',
  'utf8',
);
writeFileSync(
  join(integ, 'docs', '委派', '整合方手册.md'),
  '# 合成手册\n\n只改队列里那一行。\n',
  'utf8',
);
git(integ, ['add', '-A']);
git(integ, ['commit', '-m', '初始合成仓库']);
git(integ, ['push', 'origin', 'HEAD:main']);
git(work, ['clone', origin, dev]);
git(dev, ['config', 'user.email', 'relay@example.invalid']);
git(dev, ['config', 'user.name', 'relay']);

/** 开发替身：这一棒轮不到开发，什么都不做，只打一行。 */
const stub = join(work, 'stub-role.mjs');
writeFileSync(stub, 'console.log("RELAY-DONE 70 测试待审（整合方）");\n', 'utf8');

const ALLOW =
  'Write Edit PowerShell(git:*) PowerShell(node:*) PowerShell(corepack:*) PowerShell(gh:*)';
const integArgv = [
  claudeExe,
  '--restricted',
  '--tools',
  withAddDir ? 'PowerShell Write Edit' : 'PowerShell',
  '--allowedTools',
  ALLOW,
  '--permission-prompts',
  'none',
  '--output-format',
  'json',
  ...(withAddDir ? ['--add-dir', dataDir] : []),
  '-p',
  '读 {prompt_file}，照里面做。',
];
writeFileSync(
  join(dataDir, 'config.json'),
  `${JSON.stringify(
    {
      roles: {
        integrator: {
          argv: integArgv,
          cwd: integ,
          timeoutMinutes: 10,
          quotaPatterns: ['usage_limit_reached', 'session limit', '429'],
          quotaPauseMinutes: 120,
        },
        developer: {
          argv: [process.execPath, stub, '{prompt_file}'],
          cwd: dev,
          timeoutMinutes: 5,
          quotaPatterns: [],
          quotaPauseMinutes: 10,
        },
      },
      idleSeconds: 5,
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

const repoDirtyBefore = spawnSync('git', ['status', '--porcelain'], {
  cwd: repo,
  encoding: 'utf8',
}).stdout;

log(
  `== 乙：真 Claude 当整合方跑一棒｜${withAddDir ? '带 --add-dir <数据目录>' : '照 config.example.json'}`,
);
const r = spawnSync(process.execPath, [CLI, 'once'], {
  cwd: repo,
  encoding: 'utf8',
  env: { ...process.env, IXAEON_RELAY_DIR: dataDir, IXAEON_RELAY_NOW: '2026-10-22T02:00:00.000Z' },
  windowsHide: true,
  timeout: 900_000,
});
log(`   relay once 退出码 ${r.status}`);
log(mask((r.stdout ?? '').trim()));
if ((r.stderr ?? '').trim()) log(`   stderr：${mask((r.stderr ?? '').trim()).slice(0, 400)}`);

const maskText = (s) => mask(s);
let passed = true;
const check = (ok, what) => {
  log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) passed = false;
};

const ledgerPath = join(dataDir, 'ledger.jsonl');
const rows = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const row = rows[0];
log(`   记账：${row ? maskText(JSON.stringify(row)) : '(没有)'}`);

const mainQueue = git(integ, ['show', 'origin/main:docs/委派/队列.md']);
const status = /^\|\s*70\s*\|.*\|\s*([^|]+?)\s*\|\s*$/m.exec(mainQueue)?.[1] ?? '';
log(`   origin/main 上这一行现在是：${status}`);

const stdoutPath = join(dataDir, 'turns', '1', 'stdout.txt');
if (existsSync(stdoutPath)) {
  try {
    const j = JSON.parse(readFileSync(stdoutPath, 'utf8').trim());
    const denials = (j.permission_denials ?? []).map((d) => d.tool_name ?? '(没名字)');
    log(
      `   Claude：is_error=${j.is_error}｜被拒 ${denials.length} 条（${denials.join('、') || '无'}）` +
        `｜total_cost_usd=${j.total_cost_usd}`,
    );
    log(`   它说的（截 500 字）：${maskText(String(j.result ?? '')).slice(0, 500)}`);
  } catch {
    log(
      `   stdout.txt 不是一整个 JSON（截 300 字）：${maskText(readFileSync(stdoutPath, 'utf8')).slice(0, 300)}`,
    );
  }
}

check(status.startsWith('已完成'), 'origin/main 上这一行变成了已完成（合成）');
check(!!row, '记了一行账');
check(
  !!row && String(row.doneLine ?? '').startsWith('RELAY-DONE 70'),
  'doneLine 从 JSON 的 result 里认出来了',
);
check(
  !!row && typeof row.usage?.costUsd === 'number' && row.usage.costUsd > 0,
  'usage.costUsd 记上了',
);
check(rows.length === 1 && row?.violations?.length === 0 && !row?.timedOut, '这一棒没越界、没超时');

const repoDirtyAfter = spawnSync('git', ['status', '--porcelain'], {
  cwd: repo,
  encoding: 'utf8',
}).stdout;
check(repoDirtyBefore === repoDirtyAfter, '仓库（临时目录以外）什么都没写');
check(
  git(integ, ['status', '--porcelain']) === '',
  '整合方克隆的工作区是干净的（它自己提交推送了）',
);

log(passed ? 'RESULT 通过' : 'RESULT 没通过');
rmSync(work, { recursive: true, force: true });
process.exit(passed ? 0 : 1);
