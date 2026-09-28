/**
 * D4（契约 5）：改动包——`<数据目录>/patches/<任务 id>/` 下按原路径放改动后的
 * 文件，外加 manifest.json（changed/added/deleted/conflict 四个数组）。
 * 项目自己的 manifest.json 会被固定清单位置顶替，原文件挪到 manifest.json.project。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const normalizeRel = (p: string): string =>
  p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
/** 写文件不越出 dir：路径上不得有符号链接（链接可能指到外面）。 */
export function safeWrite(dir: string, rel: string, src: string): void {
  const dest = join(dir, rel);
  let cur = dir;
  for (const seg of rel.split('/').slice(0, -1)) {
    cur = join(cur, seg);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) {
      throw new Error(`路径上有符号链接，不往里写：${rel}`);
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

/** 把改动文件按原路径放进补丁目录并写清单。 */
export function buildPatch(
  workspace: string,
  dir: string,
  changed: string[],
  baseHashes: Record<string, string | null>,
  conflict: string[],
): void {
  const MANIFEST = 'manifest.json';
  const manifest: Record<'changed' | 'added' | 'deleted' | 'conflict', string[]> = {
    changed: [],
    added: [],
    deleted: [],
    conflict,
  };
  let displaced: string | null = null;
  for (const raw of changed) {
    const rel = normalizeRel(raw);
    const src = join(workspace, rel);
    if (rel === MANIFEST) {
      // 项目自己的清单与固定清单位置撞名：内容不丢，挪到 manifest.json.project。
      try {
        displaced = readFileSync(src, 'utf8');
        manifest.changed.push(`${rel}（原文件在 ${MANIFEST}.project）`);
      } catch {
        manifest.added.push(rel);
      }
      continue;
    }
    if (existsSync(src) && statSync(src).isFile()) {
      safeWrite(dir, rel, src);
      (baseHashes[raw] == null ? manifest.added : manifest.changed).push(rel);
    } else {
      const gone = join(dir, rel);
      if (existsSync(gone)) rmSync(gone);
      let cur = dirname(gone);
      while (cur !== dir && cur.length > dir.length) {
        try {
          if (readdirSync(cur).length > 0) break;
          rmSync(cur);
          cur = dirname(cur);
        } catch {
          break;
        }
      }
      manifest.deleted.push(rel);
    }
  }
  mkdirSync(dir, { recursive: true });
  if (displaced !== null) writeFileSync(join(dir, `${MANIFEST}.project`), displaced);
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
}
