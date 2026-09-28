/**
 * D4：点「接受」之后的落地——在项目仓库里建分支提交（规格
 * docs/委派/D4-接受后在项目里建分支.md）。
 * 前提：项目有根目录且在仍有效的文件夹授权内（isPathInside）；冲突核对与建
 * 工作树绑定同一个 HEAD 提交；临时工作树建在 IXAEON 数据目录里；任何一步
 * 失败清掉工作树改走改动包。git 全部 execFile 参数组（异步、带超时）。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isPathInside } from '../paths.js';
import { buildPatch, normalizeRel, safeWrite } from './patchPack.js';
import type { CoreDatabase } from '../db/database.js';
import type { CodingTask } from '@ixaeon/contracts';

export interface LandingOutcome {
  kind: 'branch' | 'patch' | 'none' | 'denied';
  /** 分支名或补丁目录；denied/none 为 null。 */
  ref: string | null;
  /** 没建成分支/没落地的原因（patch 与 denied 时非空）。 */
  reason: string | null;
}

/**
 * D4（契约 6）落地结果的一句话文案（对话回报与任务页共用同一句式）：
 * 建了分支说清分支名、没推送、没动工作区、怎么合并；改动包说清位置与原因；
 * 没落地写原因；没有改动如实写。changedPaths 非空但没落地的旧任务不算「没有改动」。
 */
export function landingText(t: {
  status: string;
  applied_ref: string | null;
  apply_error: string | null;
  executor_report_json: string | null;
}): string {
  if (t.applied_ref && /^ixaeon\//.test(t.applied_ref)) {
    return `已在项目仓库建分支 ${t.applied_ref}（没有推送，也没动你的工作区）。要合并：git merge ${t.applied_ref}`;
  }
  if (t.applied_ref) return `改动包在 ${t.applied_ref}（${t.apply_error ?? '原因未记录'}）`;
  if (t.apply_error) return t.apply_error;
  if (t.status !== 'completed') return '';
  const changed = t.executor_report_json
    ? ((JSON.parse(t.executor_report_json) as { changedPaths?: string[] }).changedPaths ?? [])
    : [];
  return changed.length === 0 ? '这次没有改动文件（没有改动）' : '改动还在隔离副本里，未落地';
}

interface ReportShape {
  changedPaths?: string[];
  baseHashes?: Record<string, string | null>;
}

const GIT_TIMEOUT_MS = 30_000;
/** 异步 git：非零退出抛错（stderr 首行），带超时与大缓冲（HEAD 里的大文件也读得动）。 */
function git(cwd: string, args: string[], maxBuffer = 512 * 1024 * 1024): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer },
      (err, out, stderr) => {
        if (err) {
          const why = (stderr || err.message || '').split('\n')[0]!.trim();
          fail(new Error(why || `git ${args[0]} 失败`));
        } else ok(out);
      },
    );
  });
}
/** 探测性 git：失败返回 null（不是 git 仓库、引用不存在、文件不在 HEAD……）。 */
async function gitTry(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}
const sha = (buf: string): string => createHash('sha256').update(buf).digest('hex');
/** HEAD 提交里这个文件的内容指纹；不在 HEAD（cat-file 失败）为 null，与基线「不存在」对齐。 */
async function headHash(root: string, rel: string): Promise<string | null> {
  const out = await gitTry(root, ['cat-file', 'blob', `HEAD:${rel}`]);
  return out === null ? null : sha(out);
}

/** 落地主流程。不抛错：失败都变成 patch 回退或 apply_error。 */
export async function landTask(
  db: CoreDatabase,
  task: CodingTask,
  dataDir: string,
): Promise<LandingOutcome> {
  const report = task.executor_report_json
    ? (JSON.parse(task.executor_report_json) as ReportShape)
    : {};
  const changed = (report.changedPaths ?? []).map((p) => normalizeRel(p));
  if (changed.length === 0) return { kind: 'none', ref: null, reason: null };
  const denied: LandingOutcome = {
    kind: 'denied',
    ref: null,
    reason: '没有这个项目目录的读取授权',
  };
  const project = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(task.project_id) as
    { root_path: string | null } | undefined;
  const root = project?.root_path ?? null;
  if (!root || !existsSync(root)) return denied;
  const perms = db
    .prepare("SELECT locator FROM permissions WHERE scope_type = 'folder' AND status = 'active'")
    .all() as Array<{ locator: string }>;
  if (!perms.some((p) => isPathInside(p.locator, root))) return denied;
  const workspace = task.workspace_path!;
  const baseHashes = report.baseHashes ?? {};
  const toPatch = async (reason: string, conflict: string[]): Promise<LandingOutcome> => {
    const dir = join(dataDir, 'patches', task.id);
    buildPatch(workspace, dir, changed, baseHashes, conflict);
    return { kind: 'patch', ref: dir, reason };
  };
  const toplevel = await gitTry(root, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) return toPatch('项目不是 git 仓库', []);
  // 项目可能登记在仓库子目录：git 路径相对仓库根。
  const repoRoot = toplevel.trim();
  const offset = normalizeRel(relative(repoRoot, resolve(root)));
  const gitRel = (rel: string): string => (offset === '' ? rel : `${offset}/${rel}`);
  // 冲突核对与建树绑定同一个 HEAD 提交，两读可变 HEAD 会被竞态绕过。
  const head = (await gitTry(root, ['rev-parse', 'HEAD']))?.trim();
  if (!head) return toPatch('仓库没有任何提交，没法建分支', []);
  const conflict: string[] = [];
  for (const rel of changed) {
    if ((baseHashes[rel] ?? null) !== (await headHash(repoRoot, gitRel(rel)))) conflict.push(rel);
  }
  if (conflict.length > 0) {
    return toPatch(`这些文件和项目当前版本不一致：${conflict.join('、')}`, conflict);
  }
  const stem = `ixaeon/${task.id.slice(0, 8)}`;
  let branch = stem;
  for (let n = 2; (await gitTry(root, ['rev-parse', '--verify', branch])) !== null; n += 1) {
    branch = `${stem}-${n}`;
  }
  const wt = join(dataDir, 'worktrees', `${task.id}-${Date.now()}`);
  // 分支只在确认是本次建出（worktree add -b 成功过）后才删，避免删掉竞态里别处建的；
  // 成功路径只清工作树、保留分支。
  let ours = false;
  const cleanup = async (dropBranch: boolean): Promise<string | null> => {
    let residue: string | null = null;
    const listed = await gitTry(repoRoot, ['worktree', 'list', '--porcelain']);
    if (listed !== null && listed.includes(wt.replaceAll('\\', '/'))) {
      if ((await gitTry(repoRoot, ['worktree', 'remove', '--force', wt])) === null) {
        residue = `工作树没清干净：${wt}`;
      }
    }
    if (existsSync(wt)) {
      try {
        rmSync(wt, { recursive: true, force: true });
      } catch {
        residue ??= `工作树目录残留：${wt}`;
      }
    }
    await gitTry(repoRoot, ['worktree', 'prune']);
    if (dropBranch && ours && (await gitTry(repoRoot, ['branch', '-D', branch])) === null) {
      residue ??= `分支没删干净：${branch}`;
    }
    return residue;
  };
  try {
    mkdirSync(dirname(wt), { recursive: true });
    try {
      await git(repoRoot, ['worktree', 'add', '-b', branch, wt, head]);
    } catch (err) {
      // 建树失败（如钩子拒绝）时分支可能已经建出：确认它指着我们绑的 HEAD 才算我们的。
      const at = (await gitTry(repoRoot, ['rev-parse', branch]))?.trim();
      if (at === head) ours = true;
      throw err;
    }
    ours = true;
    for (const rel of changed) {
      const src = join(workspace, rel);
      if (existsSync(src) && statSync(src).isFile()) {
        safeWrite(wt, rel, src);
        // :(literal) 关掉 git 的路径通配，文件名里的 [] * 才按字面处理。
        await git(wt, ['add', '--', `:(literal)${rel}`]);
      } else {
        rmSync(join(wt, rel), { force: true });
        await git(wt, ['rm', '-q', '--ignore-unmatch', '--', `:(literal)${rel}`]);
      }
    }
    // 兜底身份看全（姓名 + 邮箱都要有），配置残缺照样提交得成。
    const hasEmail = ((await gitTry(wt, ['config', 'user.email'])) ?? '').trim().length > 0;
    const hasName = ((await gitTry(wt, ['config', 'user.name'])) ?? '').trim().length > 0;
    const idArgs =
      hasEmail && hasName ? [] : ['-c', 'user.name=IXAEON', '-c', 'user.email=ixaeon@localhost'];
    const title = `IXAEON：${task.goal.split('\n')[0]!.trim()}`;
    const body = `${task.id}\n独立验证 ${task.verify_status ?? 'not_run'}`;
    await git(wt, [...idArgs, 'commit', '-m', `${title}\n\n${body}`]);
    const residue = await cleanup(false);
    // 分支已建好：清理失败如实记录（reason 带 residue），不回退成改动包。
    return residue
      ? { kind: 'branch', ref: branch, reason: `分支已建，但${residue}` }
      : { kind: 'branch', ref: branch, reason: null };
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0]!.trim() : String(err);
    const residue = await cleanup(true).catch(() => '清理也失败了');
    const patch = await toPatch(`建分支失败：${why}`, []);
    return residue ? { ...patch, reason: `${patch.reason}；且${residue}` } : patch;
  }
}
