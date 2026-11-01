/**
 * MG2 真机检查（乙）：整合方真的走本机 magpie 的分组。
 *
 * 合成一个最简调度器世界（临时裸仓库 + 队列 + 整合方工作目录），配置里整合方选
 * `group/group-ixaeon-integrator` → `relay once` 真跑一棒，贴 relay 的输出和记账那一行。
 * 不碰用户真实的 relay 目录 / 调度器配置；分组由用户在 magpie 里建。
 * 没有对应的分组时写「没跑：等用户在 magpie 里建分组」。
 *
 * 用法：node scripts/real/mg2-integrator-launch.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const root = mkdtempSync(join(tmpdir(), 'ixa-mg2-integ-'));
const MAGPIE = 'http://127.0.0.1:3425';
const INTEG_GROUP = 'group/group-ixaeon-integrator';

const mask = (s) => {
  let text = String(s);
  for (const p of [root, process.env.TEMP, process.env.USERPROFILE, homedir(), tmpdir()].filter(
    (x) => x && x.trim(),
  )) {
    text = text.split(p).join('<临时目录>');
    text = text.split(p.replaceAll('\\', '/')).join('<临时目录>');
    text = text.split(JSON.stringify(p).slice(1, -1)).join('<临时目录>');
  }
  const user = process.env.USERPROFILE ?? '';
  const name = user ? user.split(/[\\/]/).pop() : '';
  return name ? text.split(name).join('<账户名>') : text;
};
const log = (s) => console.log(mask(s));

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
};
const write = (path, text) => {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
};

async function groups() {
  const res = await fetch(`${MAGPIE}/v1/models`, {
    headers: { authorization: 'Bearer magpie' },
    signal: AbortSignal.timeout(3_000),
  });
  const body = await res.json();
  return (body.data ?? [])
    .map((x) => x.id)
    .filter((id) => typeof id === 'string' && id.startsWith('group/'));
}

function runTurn() {
  const base = join(root, 'integ');
  const bare = join(base, 'origin.git');
  const seed = join(base, 'seed');
  const integ = join(base, 'integ-clone');
  const trees = join(base, 'trees');
  const data = join(base, 'relay');
  mkdirSync(bare, { recursive: true });
  git(base, ['init', '--bare', '-b', 'main', bare]);
  write(
    join(seed, 'docs', '委派', '队列.md'),
    [
      '# 委派队列',
      '',
      '| 序号 | 任务 | 委派单或规格 | 档位 | 依赖 | 状态 |',
      '| ---- | ---- | ------------ | ---- | ---- | ---- |',
      '| 70 | MG2 合成复审 | [MG2](MG2.md) | B | 无 | 待复审（整合方） |',
      '',
    ].join('\n'),
  );
  write(
    join(seed, 'AGENTS.md'),
    '# 合成仓库规则\n\n这一棒是 MG2 的真机检查，只确认调度器起得来、答得出。不要改任何文件、不要运行命令；读完交代，最后一行只回复 `RELAY-DONE 70 已完成（2026-11-01）`。\n',
  );
  write(join(seed, 'docs', '委派', '整合方手册.md'), '# 合成手册\n\n不做事。\n');
  write(join(seed, 'docs', '委派', 'MG2.md'), '# MG2\n\n合成复审。\n');
  git(seed, ['init', '-q']);
  git(seed, ['add', '.']);
  git(seed, [
    '-c',
    'user.name=MG2',
    '-c',
    'user.email=mg2@ixaeon.invalid',
    'commit',
    '-q',
    '-m',
    'seed',
  ]);
  git(seed, ['push', '-q', bare, 'HEAD:main']);
  git(base, ['clone', '-q', bare, integ]);
  mkdirSync(trees, { recursive: true });
  mkdirSync(data, { recursive: true });

  const stub = join(base, 'stub-developer.mjs');
  write(stub, "console.log('RELAY-DONE 70 待复审（整合方）');\n");
  // Windows 上 `claude` 在 PATH 里是 .ps1 包装，spawn 不经 shell 起不来；用 npm 全局装的那个 exe。
  const fromNpm = join(
    process.env.APPDATA ?? '',
    'npm',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  const claude = process.env.CLAUDE_BIN ?? (existsSync(fromNpm) ? fromNpm : 'claude');
  write(
    join(data, 'config.json'),
    `${JSON.stringify(
      {
        roles: {
          integrator: {
            argv: [
              claude,
              '--restricted',
              '--tools',
              'Read',
              '--allowedTools',
              'Read',
              '--permission-prompts',
              'none',
              '--output-format',
              'json',
              '--add-dir',
              join(data, 'turns'),
              '-p',
              '读 {prompt_file}，照里面做。',
            ],
            cwd: integ,
            timeoutMinutes: 5,
            quotaPatterns: ['usage_limit_reached', 'session limit'],
            quotaPauseMinutes: 120,
            magpieModel: INTEG_GROUP,
            magpieUrl: MAGPIE,
          },
          developer: {
            argv: [process.execPath, stub, '{prompt_file}'],
            cwd: integ,
            timeoutMinutes: 5,
            quotaPatterns: ['usage_limit_reached'],
            quotaPauseMinutes: 120,
          },
        },
        idleSeconds: 1,
        localUserCheck: [process.execPath, '-e', 'process.exit(0)'],
      },
      null,
      2,
    )}\n`,
  );
  write(
    join(data, 'state.json'),
    `${JSON.stringify({ stoppedReason: null, pausedUntil: {}, turns: 0 }, null, 2)}\n`,
  );

  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [join(REPO, 'packages', 'relay', 'bin', 'relay.mjs'), 'once'],
    {
      cwd: REPO,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8 * 60_000,
      env: {
        ...process.env,
        IXAEON_RELAY_DIR: data,
        IXAEON_WORKTREES: trees,
        NO_PROXY: ['127.0.0.1', 'localhost', process.env.NO_PROXY].filter(Boolean).join(','),
        no_proxy: ['127.0.0.1', 'localhost', process.env.no_proxy].filter(Boolean).join(','),
      },
    },
  );
  log(`== 乙（整合方）真的 relay once + 真的 Claude Code，模型 ${INTEG_GROUP}`);
  log(
    `   relay once 退出码：${r.status ?? '?'}｜用时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (r.error) log(`   起不来：${r.error.message}`);
  for (const line of `${r.stdout ?? ''}`.trim().split('\n').slice(-8)) log(`   ${line}`);
  const ledger = join(data, 'ledger.jsonl');
  let ok = false;
  if (existsSync(ledger)) {
    for (const line of readFileSync(ledger, 'utf8').split('\n').filter(Boolean)) {
      const j = JSON.parse(line);
      log(
        `   记账：turn=${j.turn} role=${j.role} 行=${j.taskId} → ${j.statusAfter}｜退出码 ${j.exitCode}｜RELAY-DONE ${j.doneLine ?? '没有'}`,
      );
      if (j.role === 'integrator' && j.doneLine) ok = true;
    }
  } else {
    log('   没有记账');
  }
  if (!ok) {
    for (const line of `${r.stderr ?? ''}`.trim().split('\n').slice(-8)) log(`   ${line}`);
  }
  return ok;
}

try {
  const found = await groups().catch(() => []);
  log(`magpie 的分组：${found.length} 个`);
  if (!found.includes(INTEG_GROUP)) {
    log(`== 乙（整合方）没跑：等用户在 magpie 里建分组 ${INTEG_GROUP}`);
    process.exitCode = 1;
  } else {
    const ok = runTurn();
    log(ok ? '== 结论：通过' : '== 结论：没通过');
    process.exitCode = ok ? 0 : 1;
  }
} catch (e) {
  log(`没跑成：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
