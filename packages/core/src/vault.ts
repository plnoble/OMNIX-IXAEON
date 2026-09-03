import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  /** 从相对路径解析回绝对路径。 */
  absolutePath(relative: string): string {
    const normalized = relative.replace(/\\/g, '/');
    if (!normalized.startsWith('sha256/')) {
      throw new IxaError(ErrorCodes.INVALID_REFERENCE, `非法的 vault 路径: ${relative}`);
    }
    return join(this.vaultDir, normalized.slice('sha256/'.length));
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
