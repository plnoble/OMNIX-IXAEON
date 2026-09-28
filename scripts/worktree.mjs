#!/usr/bin/env node
/**
 * IXAEON 的工作目录（git worktree）统一放在一处，不放进放项目的文件夹。
 * 2026-09-28 用户指出：按原来的写法（仓库旁边 ../ixaeon-<任务号>），放项目的文件夹里
 * 堆了 30 多个 ixaeon-* 工作目录和一百多个日志文件。
 *
 *   node scripts/worktree.mjs root                  打印工作目录的根
 *   node scripts/worktree.mjs add <任务号> [名字]     建任务工作目录 <根>/<任务号>，分支 <名字>/<任务号>
 *                                                   （名字默认 grok），并装好依赖
 *   node scripts/worktree.mjs ops [--integrator]    建好或更新操作目录，停在 origin/main：
 *                                                   执行方 <根>/ops，整合方 <根>/int
 *   node scripts/worktree.mjs clean [--dry-run]     删掉分支已并入 origin/main、且没有未提交改动的
 *                                                   任务工作目录（连同本地分支）；有改动的只报告，不删
 *
 * 根：环境变量 IXAEON_WORKTREES；没设时是主检出目录往上两级的 Worktrees/IXAEON
 * （本机：放项目的文件夹是 D:\Agent\Project，根就是 D:\Agent\Worktrees\IXAEON）。
 * 命令输出（日志）写进各自工作目录的 .logs/（已在 .gitignore），随工作目录一起删。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function must(args, opts = {}) {
  const r = git(args, opts);
  if (r.code !== 0) {
    console.error(`git ${args.join(' ')} 失败：${r.err || r.out}`);
    process.exit(1);
  }
  return r.out;
}

/** 主检出目录（所有工作目录共用的那个 .git 所在处）。 */
function mainRoot() {
  const common = must(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return dirname(common);
}

function worktreesRoot() {
  const fromEnv = process.env.IXAEON_WORKTREES?.trim();
  return fromEnv ? resolve(fromEnv) : resolve(mainRoot(), '..', '..', 'Worktrees', 'IXAEON');
}

function install(dir) {
  // 固定命令、不含外部输入；Windows 上 corepack 是 .cmd，要经 shell 才找得到
  const r = spawnSync('corepack pnpm install --frozen-lockfile --prefer-offline', {
    cwd: dir,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error(`依赖没装好（${dir}），可以进去重跑：corepack pnpm install`);
    process.exit(1);
  }
}

function listWorktrees() {
  const out = must(['worktree', 'list', '--porcelain']);
  const items = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: resolve(line.slice('worktree '.length)), branch: null, detached: false };
      items.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch refs/heads/'.length);
    } else if (cur && line === 'detached') {
      cur.detached = true;
    }
  }
  return items;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'root') {
  console.log(worktreesRoot());
} else if (cmd === 'add') {
  const task = args[0];
  const who = args[1] ?? 'grok';
  if (!task || !/^[A-Za-z0-9._-]+$/.test(task) || !/^[A-Za-z0-9._-]+$/.test(who)) {
    console.error(
      '用法：node scripts/worktree.mjs add <任务号> [名字]（只用字母、数字、点、横线、下划线）',
    );
    process.exit(1);
  }
  const dir = join(worktreesRoot(), task);
  if (existsSync(dir)) {
    console.error(`已经有这个工作目录：${dir}`);
    process.exit(1);
  }
  must(['fetch', 'origin']);
  const branch = `${who}/${task}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0) {
    must(['worktree', 'add', dir, branch]);
  } else if (
    git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).code === 0
  ) {
    must(['worktree', 'add', '-b', branch, dir, `origin/${branch}`]);
  } else {
    must(['worktree', 'add', '-b', branch, dir, 'origin/main']);
  }
  install(dir);
  console.log(dir);
} else if (cmd === 'ops') {
  const dir = join(worktreesRoot(), args.includes('--integrator') ? 'int' : 'ops');
  must(['fetch', 'origin']);
  if (!existsSync(dir)) {
    must(['worktree', 'add', '--detach', dir, 'origin/main']);
    install(dir);
  } else {
    if (git(['-C', dir, 'status', '--porcelain']).out.length > 0) {
      console.error(`操作目录里有没提交的改动，先处理再更新：${dir}`);
      process.exit(1);
    }
    must(['-C', dir, 'checkout', '--detach', 'origin/main']);
  }
  console.log(dir);
} else if (cmd === 'clean') {
  const dry = args.includes('--dry-run');
  must(['fetch', 'origin', '--prune']);
  const main = mainRoot();
  let removed = 0;
  for (const wt of listWorktrees()) {
    if (wt.path === resolve(main) || wt.detached || !wt.branch) continue;
    const merged = git(['merge-base', '--is-ancestor', wt.branch, 'origin/main']).code === 0;
    const dirty = git(['-C', wt.path, 'status', '--porcelain']).out.length > 0;
    if (!merged || dirty) {
      console.log(
        `留着 ${wt.path}（${wt.branch}）：${!merged ? '还没并入 main' : '有没提交的改动'}`,
      );
      continue;
    }
    if (dry) {
      console.log(`会删 ${wt.path}（${wt.branch}）`);
      continue;
    }
    must(['worktree', 'remove', '--force', wt.path]);
    // 上面已核对分支已并入 origin/main，删本地分支不丢提交（共用检出目录的 main 可能落后，-d 会误拒）
    git(['branch', '-D', wt.branch]);
    console.log(`已删 ${wt.path}（${wt.branch}）`);
    removed += 1;
  }
  git(['worktree', 'prune']);
  if (!dry) console.log(`共删 ${removed} 个已并入的工作目录`);
} else {
  console.error(
    '用法：node scripts/worktree.mjs root | add <任务号> [名字] | ops [--integrator] | clean [--dry-run]',
  );
  process.exit(1);
}
