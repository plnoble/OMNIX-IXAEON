/**
 * P3-A 连接器注册表验收（自查审核修复 69.2-4，迁移 25）。
 * 修复前：导入支持四平台但系统「不知道接入到哪里」——无游标、无覆盖区间、
 * 无失败原因、无撤销状态。
 * 本套件验证：
 * 1. 注册表 CRUD：幂等登记、列表、撤销后拒绝新同步；
 * 2. 成功同步推进游标与覆盖区间（单调扩展不回退）；
 * 3. 失败记录原因，不覆盖最后成功历史；
 * 4. 真实导入路径接线：ImportService 注入注册表后自动登记与推进；
 * 5. 撤销后导入被拦截（撤销的连接器不再吞新数据）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ConnectorRegistry,
  ImportService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';

let dir: string;
let db: CoreDatabase;
let registry: ConnectorRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p3a-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  db = openDatabase(join(dir, 'p3a.db'));
  migrate(db);
  registry = new ConnectorRegistry(db);
});

afterEach(() => {
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-p3a-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

describe('P3-A 连接器注册表（迁移 25）', () => {
  it('P3A-01 [幂等登记与身份唯一] 同一平台×命名空间×方式只登记一次，列表可查', () => {
    const a = registry.upsert({
      platform: 'chatgpt_export',
      accountNamespace: 'work',
      captureMethod: 'history_export',
    });
    const b = registry.upsert({
      platform: 'chatgpt_export',
      accountNamespace: 'work',
      captureMethod: 'history_export',
    });
    expect(a.id).toBe(b.id); // 幂等
    expect(registry.list().length).toBe(1);

    // 不同命名空间是不同连接器
    const c = registry.upsert({
      platform: 'chatgpt_export',
      accountNamespace: 'personal',
      captureMethod: 'history_export',
    });
    expect(c.id).not.toBe(a.id);
    expect(registry.list().length).toBe(2);
  });

  it('P3A-02 [成功同步推进游标与覆盖区间] 单调扩展，不回退', () => {
    const c = registry.upsert({
      platform: 'claude_export',
      captureMethod: 'history_export',
    });
    const r1 = registry.recordSuccess(c.id, {
      cursor: 'sync-1',
      coverageStart: '2026-01-01T00:00:00.000Z',
      coverageEnd: '2026-03-01T00:00:00.000Z',
    });
    expect(r1.sync_cursor).toBe('sync-1');
    expect(r1.last_success_at).toBeTruthy();
    expect(r1.last_failure_reason).toBeNull();

    // 更早的 coverageStart 不回退已有区间；更晚的 coverageEnd 扩展
    const r2 = registry.recordSuccess(c.id, {
      cursor: 'sync-2',
      coverageStart: '2026-02-01T00:00:00.000Z', // 晚于现有 start，不回退
      coverageEnd: '2026-05-01T00:00:00.000Z',
    });
    expect(r2.coverage_start).toBe('2026-01-01T00:00:00.000Z'); // 保持最早
    expect(r2.coverage_end).toBe('2026-05-01T00:00:00.000Z'); // 扩展到最晚
    expect(r2.sync_cursor).toBe('sync-2');
  });

  it('P3A-03 [失败记录不覆盖成功历史] 失败后仍可查到最后一次成功', () => {
    const c = registry.upsert({ platform: 'grok_export', captureMethod: 'history_export' });
    registry.recordSuccess(c.id, { cursor: 'ok-1' });
    const failed = registry.recordFailure(c.id, '导出文件损坏（JSON 解析失败）');
    expect(failed.last_failure_reason).toContain('导出文件损坏');
    expect(failed.last_success_at).toBeTruthy(); // 成功历史保留
    expect(failed.sync_cursor).toBe('ok-1'); // 游标保留
  });

  it('P3A-04 [撤销后拒绝新同步] revoked_at 记录，assertActive 抛权限错误', () => {
    const c = registry.upsert({ platform: 'gemini_export', captureMethod: 'history_export' });
    registry.recordSuccess(c.id, { cursor: 'ok-1' });
    const revoked = registry.revoke(c.id);
    expect(revoked.revoked_at).toBeTruthy();

    expect(() => registry.assertActive(c.id)).toThrow(/撤销/);
    expect(() => registry.recordSuccess(c.id, { cursor: 'should-fail' })).toThrow(/撤销/);

    // 撤销幂等（重复撤销不报错、不改变 revoked_at）
    const again = registry.revoke(c.id);
    expect(again.revoked_at).toBe(revoked.revoked_at);
  });

  it('P3A-05 [导入路径接线] ImportService 注入注册表后，真实导入自动登记并推进游标', () => {
    const projects = new ProjectService(db);
    const projectId = projects.create({ name: 'P3A', rootPath: null, description: null }).id;
    const vault = new Vault(join(dir, 'vault'));
    const perms = new PermissionService(db);
    const sources = new SourceStore(db);
    const imports = new ImportService(db, vault, perms, sources, registry);

    const file = join(dir, 'notes.md');
    writeFileSync(file, '# 项目笔记\n\n连接器注册表验收。');
    const perm = perms.grantFile(file);

    const result = imports.importFile(file, { projectId, permissionId: perm.id });
    expect(result.created.length).toBe(1);

    // 导入后注册表自动登记 local_file 连接器并推进游标
    const conns = registry.list();
    const local = conns.find((c) => c.platform === 'local_file');
    expect(local).toBeTruthy();
    expect(local!.sync_cursor).toBeTruthy();
    expect(local!.last_success_at).toBeTruthy();
    expect(local!.coverage_start).toBeTruthy();
    expect(local!.coverage_end).toBeTruthy();

    // 重复导入（幂等去重）也推进游标（新导入时刻）
    const first = local!.sync_cursor!;
    const again = imports.importFile(file, { projectId, permissionId: perm.id });
    expect(again.deduplicated.length).toBe(1);
    const after = registry.list().find((c) => c.platform === 'local_file')!;
    expect(after.sync_cursor! >= first).toBe(true);
  });

  it('P3A-06 [导入失败记录原因] 未授权路径导入失败时，连接器记录失败原因', () => {
    const projects = new ProjectService(db);
    const projectId = projects.create({ name: 'P3A-2', rootPath: null, description: null }).id;
    const vault = new Vault(join(dir, 'vault'));
    const perms = new PermissionService(db);
    const sources = new SourceStore(db);
    const imports = new ImportService(db, vault, perms, sources, registry);

    const file = join(dir, 'unauthorized.md');
    writeFileSync(file, '# 未授权文件');

    // 用一个不存在/不覆盖的授权 → 导入抛权限错误
    const otherFile = join(dir, 'other.md');
    writeFileSync(otherFile, '# 另一个文件');
    const wrongPerm = perms.grantFile(otherFile);
    expect(() => imports.importFile(file, { projectId, permissionId: wrongPerm.id })).toThrow();

    const local = registry.list().find((c) => c.platform === 'local_file');
    expect(local).toBeTruthy();
    expect(local!.last_failure_reason).toBeTruthy();
    expect(local!.last_failure_reason!.length).toBeGreaterThan(0);
  });
});
