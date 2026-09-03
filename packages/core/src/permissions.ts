import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from './db/database.js';
import type { Permission } from '@ixaeon/contracts';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { isPathInside, normalizeLocalPath } from './paths.js';

const DOMAIN_RE = /^[a-z0-9.-]+$/i;

/**
 * 授权服务：用户允许读取什么。默认无任何授权；
 * 任何导入都必须能追溯到一条 active 状态的授权记录。
 */
export class PermissionService {
  constructor(private readonly db: CoreDatabase) {}

  private rowToPermission(row: Record<string, unknown>): Permission {
    return row as unknown as Permission;
  }

  /** 单文件授权（用户通过对话框明确选择；mode=once）。 */
  grantFile(absPath: string): Permission {
    const locator = normalizeLocalPath(absPath);
    const existing = this.db
      .prepare(
        "SELECT * FROM permissions WHERE scope_type='file' AND lower(locator)=lower(?) AND status='active'",
      )
      .get(locator) as Permission | undefined;
    if (existing) return existing;
    const p: Permission = {
      id: randomUUID(),
      scope_type: 'file',
      locator,
      mode: 'once',
      status: 'active',
      granted_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(p.id, p.scope_type, p.locator, p.mode, p.status, p.granted_at, p.revoked_at);
    return p;
  }

  /** 目录授权（登记项目根目录；mode=continuous）。 */
  grantFolder(absPath: string): Permission {
    const locator = normalizeLocalPath(absPath);
    const existing = this.db
      .prepare(
        "SELECT * FROM permissions WHERE scope_type='folder' AND lower(locator)=lower(?) AND status='active'",
      )
      .get(locator) as Permission | undefined;
    if (existing) return existing;
    const p: Permission = {
      id: randomUUID(),
      scope_type: 'folder',
      locator,
      mode: 'continuous',
      status: 'active',
      granted_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(p.id, p.scope_type, p.locator, p.mode, p.status, p.granted_at, p.revoked_at);
    return p;
  }

  /** 域授权（当前仅 chatgpt.com；mode=continuous）。 */
  grantDomain(domain: string): Permission {
    const d = domain.trim().toLowerCase();
    if (!DOMAIN_RE.test(d)) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, `非法域名: ${domain}`);
    }
    const existing = this.db
      .prepare(
        "SELECT * FROM permissions WHERE scope_type='domain' AND locator=? AND status='active'",
      )
      .get(d) as Permission | undefined;
    if (existing) return existing;
    const p: Permission = {
      id: randomUUID(),
      scope_type: 'domain',
      locator: d,
      mode: 'continuous',
      status: 'active',
      granted_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(p.id, p.scope_type, p.locator, p.mode, p.status, p.granted_at, p.revoked_at);
    return p;
  }

  revoke(id: string): Permission {
    const row = this.db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as
      Permission | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `授权不存在: ${id}`);
    if (row.status === 'revoked') return row;
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE permissions SET status = ?, revoked_at = ? WHERE id = ?')
      .run('revoked', now, id);
    return { ...row, status: 'revoked', revoked_at: now };
  }

  get(id: string): Permission | null {
    const row = this.db.prepare('SELECT * FROM permissions WHERE id = ?').get(id) as
      Permission | undefined;
    return row ?? null;
  }

  list(includeRevoked = true): Permission[] {
    return this.db
      .prepare(
        includeRevoked
          ? 'SELECT * FROM permissions ORDER BY granted_at DESC'
          : "SELECT * FROM permissions WHERE status='active' ORDER BY granted_at DESC",
      )
      .all() as Permission[];
  }

  /**
   * 检查绝对路径是否落在某条 active 授权内（file 精确匹配 / folder 前缀匹配，
   * realpath 防符号链接逃逸）。返回该授权或 null。
   */
  activePermissionForPath(absPath: string): Permission | null {
    const target = normalizeLocalPath(absPath);
    const actives = this.list(false);
    let folderMatch: Permission | null = null;
    for (const p of actives) {
      if (p.scope_type === 'file') {
        if (isPathInside(p.locator, target) && isPathInside(target, p.locator)) return p;
      } else if (p.scope_type === 'folder') {
        if (isPathInside(p.locator, target)) {
          // 取最近（最长）的 folder 授权
          if (!folderMatch || p.locator.length > folderMatch.locator.length) folderMatch = p;
        }
      }
    }
    return folderMatch;
  }

  /** 断言路径已授权，否则抛 PERMISSION_DENIED。 */
  assertPathAllowed(absPath: string): Permission {
    const p = this.activePermissionForPath(absPath);
    if (!p) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        `路径未获授权，拒绝读取: ${normalizeLocalPath(absPath)}`,
      );
    }
    return p;
  }

  activePermissionForDomain(domain: string): Permission | null {
    const d = domain.trim().toLowerCase();
    const rows = this.db
      .prepare(
        "SELECT * FROM permissions WHERE scope_type='domain' AND locator=? AND status='active'",
      )
      .all(d) as Permission[];
    return rows[0] ?? null;
  }
}
