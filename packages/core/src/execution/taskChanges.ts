import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingTask, TaskChanges, TaskChangedFile } from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { normalizeRel } from './patchPack.js';
import { toLf } from './landing.js';
import { FORBIDDEN_NAME } from './workspaceCopy.js';
import { isPathInside } from '../paths.js';
// 单文件上限（超过就不读内容、只看大小）；二进制探测只在开头 8 KB 找 NUL；差异正文最多看 2000 行；
// files 最多列 50 个；差异合计上限 200 000 字符；每段上下文 3 行。
const MAX_DIFF_BYTES = 256 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MAX_DIFF_LINES = 2000;
const MAX_FILES = 50;
const MAX_DIFF_TOTAL_CHARS = 200_000;
const CONTEXT = 3;

/** 去掉末尾的空行（文件末尾有没有换行、有几个都不算差异）。 */
const trimTail = (lines: string[]): string[] => {
  const a = [...lines];
  while (a.length > 0 && a[a.length - 1] === '') a.pop();
  return a;
};

/** 路径要合规：非空、不是绝对路径、不带 ..。不合规的一个文件都不读。 */
const sanePath = (rel: string): boolean => {
  if (rel.length === 0) return false;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  const segs = rel.split('/').filter((s) => s.length > 0);
  if (segs.includes('..')) return false;
  return true;
};

/** 密钥类文件名（与 copyProjectWorkspace 同一套），不读。 */
const isSecretName = (rel: string): boolean => FORBIDDEN_NAME.test(rel.split('/').pop() ?? '');
const hasNul = (buf: Buffer): boolean => buf.subarray(0, BINARY_PROBE_BYTES).includes(0);
/** 基准指纹（与 landing.ts 同一个算法：LF 归一后 SHA-256）。 */
const sha256Lf = (buf: Buffer): string => createHash('sha256').update(toLf(buf)).digest('hex');

const statQuiet = (p: string): { size: number; isFile: boolean } | null => {
  try {
    const st = lstatSync(p, { throwIfNoEntry: false });
    return st ? { size: st.size, isFile: st.isFile() } : null;
  } catch {
    return null;
  }
};

/** 路径上任何一段（含最后一段）是链接：true。出错按有链接处理（不读）。 */
const linkOnPath = (root: string, rel: string): boolean => {
  let cur = root;
  for (const seg of rel.split('/').filter((s) => s.length > 0)) {
    cur = join(cur, seg);
    try {
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (st && st.isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
};

const kindOf = (inWs: boolean, inRoot: boolean): 'added' | 'modified' | 'deleted' =>
  inWs && !inRoot ? 'added' : !inWs && inRoot ? 'deleted' : 'modified';
/**
 * 行级 LCS 差异：每行前缀 + / - / 空格；只出有改动的段，每段带最多 3 行上下文，段间一行 @@；
 * 行尾 \r 与文件末尾换行不算差异（调用方先 toLf 再过 trimTail）。没有差异返回 null。
 */
export function lineDiff(oldLines: string[], newLines: string[]): string | null {
  const n = oldLines.length;
  const m = newLines.length;
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) return null;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Op = { t: ' ' | '+' | '-'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ t: ' ', line: newLines[j]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ t: '-', line: oldLines[i]! });
      i += 1;
    } else {
      ops.push({ t: '+', line: newLines[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ t: '-', line: oldLines[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ t: '+', line: newLines[j]! });
    j += 1;
  }
  if (ops.every((o) => o.t === ' ')) return null;
  const hot = ops.map((o) => o.t !== ' ');
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k += 1) {
    if (!hot[k]) continue;
    for (let x = Math.max(0, k - CONTEXT); x <= Math.min(ops.length - 1, k + CONTEXT); x += 1) {
      keep[x] = true;
    }
  }
  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      k += 1;
      continue;
    }
    let end = k;
    while (end + 1 < ops.length && keep[end + 1]) end += 1;
    for (let x = k; x <= end; x += 1) out.push(`${ops[x]!.t}${ops[x]!.line}`);
    out.push('@@');
    k = end + 1;
  }
  while (out.length > 0 && out[out.length - 1] === '@@') out.pop();
  return out.length === 0 ? null : out.join('\n');
}

/**
 * U3：任务页「看改动」。清单取执行报告的 changedPaths（normalizeRel、去重、排序）；
 * 比副本里现在的文件和项目文件夹里现在的文件。只读：不写任何一边，不跟链接，不起进程，不联网。
 */
export function readTaskChanges(db: CoreDatabase, task: CodingTask): TaskChanges {
  const report = task.executor_report_json
    ? (JSON.parse(task.executor_report_json) as { changedPaths?: unknown })
    : {};
  const rawList = Array.isArray(report.changedPaths)
    ? (report.changedPaths as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  if (!task.workspace_path || rawList.length === 0) return { files: [], total: 0 };
  const rels = [...new Set(rawList.map(normalizeRel))].sort();

  // 授权判断与落地同一条：项目绑了文件夹、目录还在、在有效授权之内。
  // 不满足 → 每个文件 unknown、diff null、note 写明；副本里的也不读。
  const project = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(task.project_id) as
    { root_path: string | null } | undefined;
  const root = project?.root_path ?? null;
  let authorized = false;
  if (root !== null && existsFileOrDir(root) && !linkOnPath(root, '')) {
    const perms = db
      .prepare("SELECT locator FROM permissions WHERE scope_type = 'folder' AND status = 'active'")
      .all() as Array<{ locator: string }>;
    authorized = perms.some((p) => isPathInside(p.locator, root));
  }
  const noAuthNote = '没有这个项目文件夹的读取授权，不显示内容';

  const baseHashes = task.executor_report_json
    ? ((JSON.parse(task.executor_report_json) as { baseHashes?: Record<string, string> })
        .baseHashes ?? null)
    : null;

  const files: TaskChangedFile[] = [];
  let diffBudgetLeft = MAX_DIFF_TOTAL_CHARS;
  for (const rel of rels) {
    if (files.length >= MAX_FILES) break;
    files.push(entry(rel));
  }
  return { files, total: rels.length };

  function entry(rel: string): TaskChangedFile {
    if (!sanePath(rel)) return { path: rel, kind: 'unknown', diff: null, note: '路径不合规' };
    if (isSecretName(rel))
      return { path: rel, kind: 'unknown', diff: null, note: '密钥类文件，不显示内容' };
    const wsAbs = join(task.workspace_path!, rel);
    const rootAbs = root === null ? null : join(root, rel);
    if (linkOnPath(task.workspace_path!, rel) || (root !== null && linkOnPath(root, rel)))
      return { path: rel, kind: 'unknown', diff: null, note: '是链接，不显示' };
    const wsStat = statQuiet(wsAbs);
    const rootStat = rootAbs === null ? null : statQuiet(rootAbs);
    if ((wsStat !== null && !wsStat.isFile) || (rootStat !== null && !rootStat.isFile))
      return { path: rel, kind: 'unknown', diff: null, note: '不是普通文件' };
    const inWs = wsStat !== null;
    const inRoot = rootStat !== null;
    if (!authorized) return { path: rel, kind: 'unknown', diff: null, note: noAuthNote };
    if (!inWs && !inRoot)
      return { path: rel, kind: 'unknown', diff: null, note: '项目里和副本里都没有这个文件' };
    if ((wsStat?.size ?? 0) > MAX_DIFF_BYTES || (rootStat?.size ?? 0) > MAX_DIFF_BYTES)
      return {
        path: rel,
        kind: kindOf(inWs, inRoot),
        diff: null,
        note: '文件太大，不显示差异',
      };
    let wsBuf: Buffer | null = null;
    let rootBuf: Buffer | null = null;
    try {
      if (inWs) wsBuf = readFileSync(wsAbs);
      if (inRoot && rootAbs !== null) rootBuf = readFileSync(rootAbs);
    } catch {
      return { path: rel, kind: 'unknown', diff: null, note: '读不出来' };
    }
    if ((wsBuf !== null && hasNul(wsBuf)) || (rootBuf !== null && hasNul(rootBuf)))
      return {
        path: rel,
        kind: kindOf(inWs, inRoot),
        diff: null,
        note: '二进制文件，不显示差异',
      };
    const wsText = wsBuf === null ? null : toLf(wsBuf).toString('utf8');
    const rootText = rootBuf === null ? null : toLf(rootBuf).toString('utf8');
    const wsLines = trimTail(wsText === null ? [] : wsText.split('\n'));
    const rootLines = trimTail(rootText === null ? [] : rootText.split('\n'));
    if (wsLines.length > MAX_DIFF_LINES || rootLines.length > MAX_DIFF_LINES)
      return {
        path: rel,
        kind: kindOf(inWs, inRoot),
        diff: null,
        note: '行数太多，不显示差异',
      };

    const kind = kindOf(inWs, inRoot);
    if (rootLines.length === wsLines.length && rootLines.every((line, i) => line === wsLines[i])) {
      const onlyEol = rootText !== null && wsText !== null && rootText !== wsText;
      return {
        path: rel,
        kind: 'same',
        diff: null,
        note: onlyEol ? '只有换行符不同' : '和项目里现在的文件一样（可能已经合并过了）',
      };
    }

    // 基准变没变：任务开始时的指纹（LF 归一 SHA-256）与项目里现在的比。
    // 契约 8：这句只挂给给得出差异的文件，所以先算 diff 再决定写不写。
    const driftedNote = (() => {
      if (baseHashes === null) return null;
      const nowHash = rootBuf === null ? null : sha256Lf(rootBuf);
      const was = baseHashes[rel] ?? null;
      const changed = was !== null ? was !== nowHash : inRoot;
      return changed ? '项目里的这个文件在任务开始之后变过，下面是和现在的文件比的' : null;
    })();
    const notes: string[] = [];
    let diff: string | null;
    if (diffBudgetLeft <= 0) {
      diff = null;
      notes.push('改动太多，后面的不显示差异');
    } else {
      diff = lineDiff(rootLines, wsLines);
      if (diff !== null) {
        diffBudgetLeft -= diff.length;
        if (driftedNote !== null) notes.push(driftedNote);
      }
    }
    return {
      path: rel,
      kind,
      diff,
      note: notes.length > 0 ? notes.join('；') : null,
    };
  }
}

function existsFileOrDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() || statSync(p).isFile();
  } catch {
    return false;
  }
}
