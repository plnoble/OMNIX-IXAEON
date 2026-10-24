/**
 * L11b 契约第 1 条：替开发推 `main` 被拒、rebase 撞上 `docs/委派/队列.md` 的行冲突时，按行合。
 *
 * 只有主表（照 `parseMainTable` 的表头认）里两边改的**不是同一行**才合得起来；
 * 表头、分隔行不一样，同一个序号两边改得不一样，或者表外的说明文字两边都改了，回 `null`。
 * 换行照 `ours`（`\r\n` 还是 `\n`）。
 */
/** 主表的六栏（和 `parseMainTableFull` 认的一样）。 */
const HEADER = ['序号', '任务', '委派单或规格', '档位', '依赖', '状态'];

const cellsOf = (line: string): string[] | null =>
  line.trim().startsWith('|')
    ? line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
    : null;

const isSeparator = (line: string): boolean => {
  const c = cellsOf(line);
  return !!c && c.every((x) => /^:?-{2,}:?$/.test(x));
};

interface Table {
  /** 表头是第几行（0 数起）。 */
  start: number;
  /** 表格结束后的第一行。 */
  end: number;
  header: string;
  separator: string;
  rows: Array<{ no: string; line: string }>;
}

/** 认主表：第一张表头含六栏的表；后面紧跟着的必须是分隔行。 */
function tableOf(md: string): Table | null {
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = cellsOf(lines[i]!);
    if (!head || !HEADER.every((h) => head.includes(h))) continue;
    const separator = lines[i + 1];
    if (separator === undefined || !isSeparator(separator)) return null;
    const rows: Table['rows'] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const c = cellsOf(lines[j]!);
      if (!c) break;
      if (c.every((x) => /^:?-{2,}:?$/.test(x))) continue;
      rows.push({ no: c[0]!, line: lines[j]! });
    }
    return { start: i, end: j, header: lines[i]!, separator, rows };
  }
  return null;
}

const sameLines = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** 表前、表后那整段：照契约三方比，合不了回 null。 */
const pickSegment = (base: string[], ours: string[], theirs: string[]): string[] | null => {
  if (sameLines(ours, base)) return theirs;
  if (sameLines(theirs, base)) return ours;
  if (sameLines(ours, theirs)) return ours;
  return null;
};

/** 一个序号 → 那一行；同一份里序号重复（对不上）回 null。 */
function rowsByNo(table: Table): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const row of table.rows) {
    if (map.has(row.no)) return null;
    map.set(row.no, row.line);
  }
  return map;
}

export function mergeQueue(base: string, ours: string, theirs: string): string | null {
  const b = tableOf(base);
  const o = tableOf(ours);
  const t = tableOf(theirs);
  if (!b || !o || !t) return null;
  // 表头和分隔行三份必须一字不差（`\r` 已按行去掉，换行照 ours）。
  if (o.header !== b.header || t.header !== b.header) return null;
  if (o.separator !== b.separator || t.separator !== b.separator) return null;

  const bRows = rowsByNo(b);
  const oRows = rowsByNo(o);
  const tRows = rowsByNo(t);
  if (!bRows || !oRows || !tRows) return null;

  const out: string[] = [];
  for (const row of b.rows) {
    const oLine = oRows.get(row.no);
    const tLine = tRows.get(row.no);
    let pick: string | undefined;
    if (oLine === row.line) pick = tLine;
    else if (tLine === row.line) pick = oLine;
    else if (oLine === tLine) pick = oLine;
    else return null;
    if (pick !== undefined) out.push(pick);
  }

  // `base` 里没有的新行：先 ours 加的（照 ours 的先后），再 theirs 加的；两边都加同一个序号就只放一次。
  for (const row of o.rows) {
    if (bRows.has(row.no)) continue;
    out.push(row.line);
  }
  for (const row of t.rows) {
    if (bRows.has(row.no) || oRows.has(row.no)) continue;
    out.push(row.line);
  }
  for (const row of o.rows) {
    if (bRows.has(row.no)) continue;
    const other = tRows.get(row.no);
    if (other !== undefined && other !== row.line) return null;
  }

  const oursLines = ours.split(/\r?\n/);
  const baseLines = base.split(/\r?\n/);
  const theirsLines = theirs.split(/\r?\n/);
  const before = pickSegment(
    baseLines.slice(0, b.start),
    oursLines.slice(0, o.start),
    theirsLines.slice(0, t.start),
  );
  const after = pickSegment(
    baseLines.slice(b.end),
    oursLines.slice(o.end),
    theirsLines.slice(t.end),
  );
  if (!before || !after) return null;

  const nl = ours.includes('\r\n') ? '\r\n' : '\n';
  return [...before, o.header, o.separator, ...out, ...after].join(nl);
}
