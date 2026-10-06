import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
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
const NOTE_SAME = '和项目里现在的文件一样（可能已经合并过了）';
const NOTE_EOL = '只有换行符不同';
/** 文本 → 行：只豁免文件末尾的一个终止换行，其余空行照算。 */
const linesOf = (text: string | null): string[] =>
  text === null ? [] : text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
/** 相对、非空、不带 .. 的路径才合规；不合规的一个文件都不读。 */
const sanePath = (rel: string): boolean =>
  rel.length > 0 &&
  !rel.startsWith('/') &&
  !/^[a-zA-Z]:/.test(rel) &&
  !rel.split('/').filter(Boolean).includes('..');
/** 密钥类文件名（与 copyProjectWorkspace 同一套），不读。 */
const isSecretName = (rel: string): boolean => FORBIDDEN_NAME.test(rel.split('/').pop() ?? '');
const hasNul = (buf: Buffer): boolean => buf.subarray(0, BINARY_PROBE_BYTES).includes(0);
/** 基准指纹（与 landing.ts 同一个算法：LF 归一后 SHA-256）。 */
const sha256Lf = (buf: Buffer): string => createHash('sha256').update(toLf(buf)).digest('hex');

const lstatQuiet = (p: string): Stats | null => {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
};
/** 路径是链接；lstat 出错按「是链接」处理（宁愿不看）。 */
const isLinkAt = (p: string): boolean => {
  try {
    const st = lstatSync(p, { throwIfNoEntry: false });
    return st !== null && st !== undefined && st.isSymbolicLink();
  } catch {
    return true;
  }
};
/** 根目录本身，或路径上任何一段（含最后一段）是链接：true。 */
const linkOnPath = (root: string, rel: string): boolean => {
  if (isLinkAt(root)) return true;
  let cur = root;
  for (const seg of rel.split('/').filter((s) => s.length > 0)) {
    cur = join(cur, seg);
    if (isLinkAt(cur)) return true;
  }
  return false;
};
// 打开 → fstat 复核（与检查过的 lstat 是同一个对象、普通文件、没超大）→ 限量读回。open 前最后一跳
// 再查整链链接，open 用 O_NOFOLLOW；换文件靠 dev/ino 拦，被写大靠限量 readSync 拦。不行返回 null，不带出内容。
const readChecked = (p: string, expect: Stats, root: string, rel: string): Buffer | null => {
  try {
    if (linkOnPath(root, rel)) return null;
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null;
      if (st.dev !== expect.dev || st.ino !== expect.ino || st.ino === 0) return null;
      const buf = Buffer.allocUnsafe(MAX_DIFF_BYTES + 1);
      const got = readSync(fd, buf, 0, buf.length);
      return got <= 0 || got > MAX_DIFF_BYTES ? null : Buffer.from(buf.subarray(0, got));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
};
/** 看不了时的统一返回：没有差异、只有原因。 */
type Note = { path: string; kind: TaskChangedFile['kind']; diff: null; note: string };

/**
 * 行级 LCS 差异：每行前缀 + / - / 空格；只出有改动的段，每段带最多 3 行上下文，段间一行 @@；
 * 行尾 \r 与文件末尾换行不算差异（调用方先 toLf 再过 linesOf）。没有差异返回 null。
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
  // 契约 10：没有副本（路径空或目录已不在）、清单空 → 空清单，不报错。
  if (!task.workspace_path || !dirExists(task.workspace_path) || rawList.length === 0)
    return { files: [], total: 0 };
  const rels = [...new Set(rawList.map(normalizeRel))].sort();
  // 授权判断与落地同一条：项目绑了文件夹、目录还在、在有效授权之内。
  // 不满足 → 每个文件 unknown、diff null、note 写明；副本里的也不读。
  const project = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(task.project_id) as
    { root_path: string | null } | undefined;
  const root = project?.root_path ?? null;
  let authorized = false;
  if (root !== null && dirExists(root) && !linkOnPath(root, '')) {
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
    const blocked = (kind: TaskChangedFile['kind'], note: string): Note => ({
      path: rel,
      kind,
      diff: null,
      note,
    });
    // 授权查在最前：撤销授权时每个文件统一提示没有授权，连路径都不解析。
    if (!authorized) return blocked('unknown', noAuthNote);
    if (!sanePath(rel)) return blocked('unknown', '路径不合规');
    if (isSecretName(rel)) return blocked('unknown', '密钥类文件，不显示内容');
    const wsAbs = join(task.workspace_path!, rel);
    const rootAbs = root === null ? null : join(root, rel);
    if (linkOnPath(task.workspace_path!, rel) || (root !== null && linkOnPath(root, rel)))
      return blocked('unknown', '是链接，不显示');
    const wsStat = lstatQuiet(wsAbs);
    const rootStat = rootAbs === null ? null : lstatQuiet(rootAbs);
    if ((wsStat !== null && !wsStat.isFile()) || (rootStat !== null && !rootStat.isFile()))
      return blocked('unknown', '不是普通文件');
    const inWs = wsStat !== null;
    const inRoot = rootStat !== null;
    if (!inWs && !inRoot) return blocked('unknown', '项目里和副本里都没有这个文件');
    const kind = kindOf(inWs, inRoot);
    if ((wsStat?.size ?? 0) > MAX_DIFF_BYTES || (rootStat?.size ?? 0) > MAX_DIFF_BYTES)
      return blocked(kind, '文件太大，不显示差异');
    const wsBuf = inWs ? readChecked(wsAbs, wsStat!, task.workspace_path!, rel) : null;
    const rootBuf =
      inRoot && rootAbs !== null && root !== null
        ? readChecked(rootAbs, rootStat!, root, rel)
        : null;
    if ((inWs && wsBuf === null) || (inRoot && rootBuf === null))
      return blocked('unknown', '读不出来');
    if ((wsBuf !== null && hasNul(wsBuf)) || (rootBuf !== null && hasNul(rootBuf)))
      return blocked(kind, '二进制文件，不显示差异');
    const wsRaw = wsBuf?.toString('utf8') ?? null;
    const rootRaw = rootBuf?.toString('utf8') ?? null;
    const wsLines = linesOf(wsRaw === null ? null : toLf(wsBuf!).toString('utf8'));
    const rootLines = linesOf(rootRaw === null ? null : toLf(rootBuf!).toString('utf8'));
    if (wsLines.length > MAX_DIFF_LINES || rootLines.length > MAX_DIFF_LINES)
      return blocked(kind, '行数太多，不显示差异');
    if (
      inWs &&
      inRoot &&
      rootLines.length === wsLines.length &&
      rootLines.every((line, i) => line === wsLines[i])
    ) {
      // 归一化后行一样：原文一字不差才算「已经合并过了」，只差 CRLF/末尾换行是「只有换行符不同」。
      return {
        path: rel,
        kind: 'same',
        diff: null,
        note: rootRaw !== null && rootRaw === wsRaw ? NOTE_SAME : NOTE_EOL,
      };
    }
    // 基准变没变：报告里没这项的不猜；null = 任务开始时还没有，现在有了 = 变过；字符串就比指纹。
    // 这句只挂给给得出差异的文件，所以先算 diff 再决定写不写。
    let drift: string | null = null;
    if (baseHashes !== null && Object.prototype.hasOwnProperty.call(baseHashes, rel)) {
      const was = baseHashes[rel] ?? null;
      const changed = was !== null ? was !== (rootBuf === null ? null : sha256Lf(rootBuf)) : inRoot;
      if (changed) drift = '项目里的这个文件在任务开始之后变过，下面是和现在的文件比的';
    }
    const notes: string[] = [];
    let diff: string | null;
    if (diffBudgetLeft <= 0) {
      diff = null;
      notes.push('改动太多，后面的不显示差异');
    } else {
      diff = lineDiff(rootLines, wsLines);
      if (diff !== null) {
        diffBudgetLeft -= diff.length;
        if (drift !== null) notes.push(drift);
      }
    }
    return { path: rel, kind, diff, note: notes.length > 0 ? notes.join('；') : null };
  }
}

const kindOf = (inWs: boolean, inRoot: boolean): 'added' | 'modified' | 'deleted' =>
  inWs && !inRoot ? 'added' : !inWs && inRoot ? 'deleted' : 'modified';

/** 是一个还在的目录（被文件、死链顶掉都不算）。 */
function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
