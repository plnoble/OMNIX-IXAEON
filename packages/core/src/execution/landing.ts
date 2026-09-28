/**
 * D4：点「接受」之后的落地——在项目仓库里建分支提交（规格
 * docs/委派/D4-接受后在项目里建分支.md）。
 *
 * - 前提：项目有根目录，且根目录在某个仍有效的文件夹授权之内
 *   （isPathInside，同 G02）；否则不落地，apply_error 写明。
 * - 冲突核对（契约 3）：派发时存进执行报告的 baseHashes（改之前的指纹，
 *   新文件记为不存在）与项目当前 HEAD 比对；对不上 → 不建分支，改走改动包。
 * - git 仓库：分支 ixaeon/<任务 id 前 8 位>（已存在则 -2、-3…），从当前 HEAD
 *   用 `git worktree add -b` 建临时工作树（建在 IXAEON 数据目录里，不在用户
 *   项目里、也不在它旁边），写入改动文件的最终内容（删掉的照删），提交后
 *   `git worktree remove` 清掉。不推送、不碰用户的工作区/当前分支/暂存区。
 * - 改动包（不是 git 仓库、有冲突、建分支失败）：<数据目录>/patches/<任务 id>/
 *   按原路径放改动后的文件 + manifest.json（changed/added/deleted/conflict）。
 * - git 一律 execFile 传参数组；任何一步失败都要清掉临时工作树再改走改动包（契约 7）。
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { CoreDatabase } from '../db/database.js';
import { isPathInside } from '../paths.js';
import type { CodingTask } from '@ixaeon/contracts';

export interface LandingOutcome {
  kind: 'branch' | 'patch' | 'none' | 'denied';
  /** 分支名或补丁目录；denied/none 为 null。 */
  ref: string | null;
  /** 没建成分支/没落地的原因（patch 与 denied 时非空）。 */
  reason: string | null;
}

interface ReportShape {
  changedPaths?: string[];
  baseHashes?: Record<string, string | null>;
}

function gitOk(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8' }) };
  } catch {
    return { ok: false, out: '' };
  }
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitBin(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd });
}

const sha = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/** 项目当前 HEAD 里这个文件的内容指纹；不在 HEAD 里记为 null（与基线「不存在」对齐）。 */
function headHash(root: string, rel: string): string | null {
  try {
    return sha(gitBin(root, ['show', `HEAD:${rel}`]));
  } catch {
    return null;
  }
}

function copyInto(dir: string, rel: string, src: string): void {
  const dest = join(dir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

/** 递归删空目录，保持补丁目录干净（删掉文件的空父目录不留）。 */
function pruneEmpty(dir: string, stop: string): void {
  let cur = dir;
  while (cur !== stop && cur.length > stop.length) {
    try {
      if (readdirSync(cur).length > 0) return;
      rmSync(cur);
      cur = dirname(cur);
    } catch {
      return;
    }
  }
}

/**
 * 落地主流程。不抛错：所有失败都变成 patch 回退或 apply_error。
 * 结果（applied_ref/applied_at/apply_error）由调用方写回任务行。
 */
export function landTask(db: CoreDatabase, task: CodingTask, dataDir: string): LandingOutcome {
  const report = task.executor_report_json
    ? (JSON.parse(task.executor_report_json) as ReportShape)
    : {};
  const changed = (report.changedPaths ?? []).map((p) => p.replaceAll('\\', '/'));
  if (changed.length === 0) return { kind: 'none', ref: null, reason: null };
  const project = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(task.project_id) as
    { root_path: string | null } | undefined;
  const root = project?.root_path ?? null;
  const denied: LandingOutcome = {
    kind: 'denied',
    ref: null,
    reason: '没有这个项目目录的读取授权',
  };
  if (!root || !existsSync(root)) return denied;
  const perms = db
    .prepare("SELECT locator FROM permissions WHERE scope_type = 'folder' AND status = 'active'")
    .all() as Array<{ locator: string }>;
  if (!perms.some((p) => isPathInside(p.locator, root))) return denied;
  const workspace = task.workspace_path!;
  const baseHashes = report.baseHashes ?? {};
  const toPatch = (reason: string, conflict: string[]): LandingOutcome => {
    const dir = join(dataDir, 'patches', task.id);
    const manifest: Record<'changed' | 'added' | 'deleted' | 'conflict', string[]> = {
      changed: [],
      added: [],
      deleted: [],
      conflict,
    };
    for (const rel of changed) {
      const src = join(workspace, rel);
      if (existsSync(src) && statSync(src).isFile()) {
        copyInto(dir, rel, src);
        if (baseHashes[rel] == null) manifest.added.push(rel);
        else manifest.changed.push(rel);
      } else {
        const gone = join(dir, rel);
        if (existsSync(gone)) rmSync(gone);
        pruneEmpty(dirname(gone), dir);
        manifest.deleted.push(rel);
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { kind: 'patch', ref: dir, reason };
  };
  if (!gitOk(root, ['rev-parse', '--show-toplevel']).ok) {
    return toPatch('项目不是 git 仓库', []);
  }
  // 契约 3：基线（改之前的指纹，新文件 null）与项目当前 HEAD 比对。
  const conflict = changed.filter((rel) => (baseHashes[rel] ?? null) !== headHash(root, rel));
  if (conflict.length > 0) {
    return toPatch(`这些文件和项目当前版本不一致：${conflict.join('、')}`, conflict);
  }
  // 契约 4：从当前 HEAD 建分支；工作树建在数据目录里（不碰用户项目及其旁边）。
  const stem = `ixaeon/${task.id.slice(0, 8)}`;
  let branch = stem;
  for (let n = 2; gitOk(root, ['rev-parse', '--verify', branch]).ok; n += 1) {
    branch = `${stem}-${n}`;
  }
  const wt = join(dataDir, 'worktrees', `${task.id}-${Date.now()}`);
  const cleanupWorktree = (): void => {
    gitOk(root, ['worktree', 'remove', '--force', wt]);
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
    gitOk(root, ['worktree', 'prune']);
    gitOk(root, ['branch', '-D', branch]);
  };
  try {
    mkdirSync(dirname(wt), { recursive: true });
    execFileSync('git', ['-C', root, 'worktree', 'add', '-b', branch, wt, 'HEAD']);
    for (const rel of changed) {
      const src = join(workspace, rel);
      const dest = join(wt, rel);
      if (existsSync(src) && statSync(src).isFile()) {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest);
        gitOut(wt, ['add', '--', rel]);
      } else {
        rmSync(dest, { force: true });
        gitOut(wt, ['rm', '-q', '--ignore-unmatch', '--', rel]);
      }
    }
    // 仓库没配置提交人时用 IXAEON 兜底身份（契约 4）。
    const idArgs = gitOk(wt, ['config', 'user.email']).out.trim()
      ? []
      : ['-c', 'user.name=IXAEON', '-c', 'user.email=ixaeon@localhost'];
    const title = `IXAEON：${task.goal.split('\n')[0]!.trim()}`;
    const body = `${task.id}\n独立验证 ${task.verify_status ?? 'not_run'}`;
    execFileSync('git', [...idArgs, '-C', wt, 'commit', '-m', `${title}\n\n${body}`]);
    // 提交成了：分支已存在，之后只剩清理——清理失败也不回退成改动包（那会既留分支又留包）。
    try {
      gitOk(root, ['worktree', 'remove', wt]);
      if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
      gitOk(root, ['worktree', 'prune']);
    } catch {
      /* 残留会在 git worktree list 里现形 */
    }
    return { kind: 'branch', ref: branch, reason: null };
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0]!.trim() : String(err);
    cleanupWorktree();
    return toPatch(`建分支失败：${why}`, []);
  }
}
