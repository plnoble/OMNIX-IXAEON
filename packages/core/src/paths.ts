import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

const IS_WINDOWS = process.platform === 'win32';

/** 规范化为绝对路径（不做 realpath，用于登记与比较）。 */
export function normalizeLocalPath(p: string): string {
  return resolve(p);
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    // 目标可能尚不存在（例如即将写出的文件）：退回词法规范化
    return resolve(p);
  }
}

/** 同一路径比较（Windows 大小写不敏感）。 */
function samePath(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 判断 target 是否位于 root 内（含 root 本身）。
 * 双方都做 realpath，防止符号链接 / junction 逃逸。
 */
export function isPathInside(root: string, target: string): boolean {
  const r = real(root);
  const t = real(target);
  if (samePath(r, t)) return true;
  // Windows 盘符大小写、分隔符统一后比较前缀
  const rn = IS_WINDOWS ? r.toLowerCase() : r;
  const tn = IS_WINDOWS ? t.toLowerCase() : t;
  return tn.startsWith(rn.endsWith(sep) ? rn : rn + sep);
}

/** 断言 target 位于 root 内，否则抛出 PATH_ESCAPE。 */
export function assertInside(root: string, target: string): void {
  if (!isPathInside(root, target)) {
    throw new IxaError(ErrorCodes.PATH_ESCAPE, `路径越界：目标 ${target} 不在授权范围 ${root} 内`);
  }
}

/**
 * ZIP 条目安全拼接：拒绝绝对路径、盘符、`..` 段，保证结果落在 baseDir 内。
 * 返回 null 表示该条目非法（调用方应跳过或报错）。
 */
export function safeJoin(baseDir: string, entryName: string): string | null {
  // 统一分隔符，检查可疑模式
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.includes('\0')) return null;
  if (isAbsolute(normalized)) return null;
  if (/^[a-zA-Z]:/i.test(normalized)) return null;
  if (normalized.startsWith('/') || normalized.startsWith('//')) return null;
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '..') return null;
  }
  const joined = join(baseDir, ...parts);
  if (!isPathInside(baseDir, joined)) return null;
  return joined;
}
