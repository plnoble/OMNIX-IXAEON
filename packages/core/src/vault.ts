import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 原文内容指纹库：按 SHA-256 存放原件，一份内容只保存一次，只增不改。
 * 布局：<vaultDir>/<hash 前 2 位>/<完整 hash>
 */
export class Vault {
  constructor(private readonly vaultDir: string) {}

  private pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new IxaError(ErrorCodes.UNKNOWN, `非法的内容指纹: ${hash.slice(0, 8)}`);
    }
    return join(this.vaultDir, hash.slice(0, 2), hash);
  }

  /** vault 内相对路径（sources.raw_path 记录这个形式，恢复时按布局重建）。 */
  static relativePathFor(hash: string): string {
    return join('sha256', hash.slice(0, 2), hash);
  }

  /** 严格校验 vault 相对路径格式：sha256/[0-9a-f]{2}/[0-9a-f]{64}（拒绝 ../、绝对路径、盘符、异常长度）。 */
  static isStrictVaultRelPath(relative: string): boolean {
    const normalized = relative.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(normalized);
  }

  /**
   * 从相对路径解析回绝对路径。
   * 严格格式校验 + 结果必须仍在 vault 根内（防恢复包携带恶意 raw_path
   * 诱导后续导出/读取越过数据目录）。
   */
  absolutePath(relative: string): string {
    if (!Vault.isStrictVaultRelPath(relative)) {
      throw new IxaError(
        ErrorCodes.INVALID_REFERENCE,
        `非法的 vault 路径（应为 sha256/xx/<64位哈希>）: ${relative.slice(0, 60)}`,
      );
    }
    const normalized = relative.replace(/\\/g, '/');
    const abs = join(this.vaultDir, normalized.slice('sha256/'.length));
    const root = resolve(this.vaultDir);
    const resolvedAbs = resolve(abs);
    if (
      !resolvedAbs.toLowerCase().startsWith(root.toLowerCase() + sep) &&
      resolvedAbs.toLowerCase() !== root.toLowerCase()
    ) {
      throw new IxaError(ErrorCodes.INVALID_REFERENCE, `vault 路径越界: ${relative.slice(0, 60)}`);
    }
    return resolvedAbs;
  }

  has(hash: string): boolean {
    try {
      return existsSync(this.pathFor(hash));
    } catch {
      return false;
    }
  }

  read(hash: string): Buffer {
    const p = this.pathFor(hash);
    if (!existsSync(p)) {
      throw new IxaError(ErrorCodes.NOT_FOUND, `vault 中不存在内容 ${hash.slice(0, 8)}`);
    }
    return readFileSync(p);
  }

  /**
   * 存入内容并返回指纹信息。已存在时直接复用（不覆盖、不报错）。
   */
  store(content: Buffer | string): { hash: string; path: string; created: boolean } {
    const hash = sha256(content);
    const path = this.pathFor(hash);
    if (existsSync(path)) {
      return { hash, path, created: false };
    }
    mkdirSync(join(this.vaultDir, hash.slice(0, 2)), { recursive: true });
    // 'wx' 旗标：仅在文件不存在时写入，保证只增不改
    writeFileSync(path, content, { flag: 'wx' });
    return { hash, path, created: true };
  }

  /** 指纹文件数量（导出与诊断用）。 */
  count(): number {
    return this.listHashes().length;
  }

  listHashes(): string[] {
    const out: string[] = [];
    if (!existsSync(this.vaultDir)) return out;
    for (const dir of readdirSync(this.vaultDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const f of readdirSync(join(this.vaultDir, dir.name))) {
        if (/^[0-9a-f]{64}$/.test(f)) out.push(f);
      }
    }
    return out;
  }
}
