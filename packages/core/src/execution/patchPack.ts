/**
 * D4（契约 5）：改动包——`<数据目录>/patches/<任务 id>/` 下按原路径放改动后的
 * 文件，外加 manifest.json（changed/added/deleted/conflict 四个数组）。
 * 项目自己的 manifest.json 会被清单顶替，内容另存 manifest.json.project
 * （撞名处理是执行方自定方案，待整合方定——见交付说明已知缺口）。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
): { displacedManifest: boolean } {
  const MANIFEST = 'manifest.json';
  const manifest: Record<'changed' | 'added' | 'deleted' | 'conflict', string[]> = {
    changed: [],
    added: [],
    deleted: [],
    conflict,
  };
  let displaced = false;
  for (const raw of changed) {
    const rel = normalizeRel(raw);
    const src = join(workspace, rel);
    if (rel === MANIFEST) {
      // 项目自己的 manifest.json 与固定清单位置撞名：清单按普通文件**如实**分类
      // （不混说明文字），内容另存 manifest.json.project（该名也被改时顺延 .2/.3…，
      // 谁都不覆盖谁）；撞名处理待整合方定（已知缺口）。
      if (existsSync(src) && statSync(src).isFile()) {
        let keep = `${MANIFEST}.project`;
        for (let n = 2; existsSync(join(dir, keep)); n += 1) keep = `${MANIFEST}.project.${n}`;
        safeWrite(dir, keep, src);
        displaced = true;
        (baseHashes[raw] == null ? manifest.added : manifest.changed).push(rel);
      } else {
        manifest.deleted.push(rel);
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
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  return { displacedManifest: displaced };
}
