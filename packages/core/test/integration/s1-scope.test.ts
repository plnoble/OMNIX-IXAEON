import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  currentMigrationVersion,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  ItemService,
  McpService,
  ArchiveService,
  derivedNeedsReasons,
  type CoreDatabase,
} from '../../src/index.js';
import { ErrorCodes } from '@ixaeon/contracts';

/**
 * S1 个人层与权限：A01 / A02 / A11（MCP）/ A12（迁移+导出）。
 */

let dir: string;
let db: CoreDatabase;
let items: ItemService;
let projects: ProjectService;
let perms: PermissionService;
let sources: SourceStore;
let imports: ImportService;
let mcp: McpService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
  items = new ItemService(db);
  mcp = new McpService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('A12 迁移 11', () => {
  it('全新库版本为 11，且旧空归属映射为 unassigned', () => {
    expect(currentMigrationVersion(db)).toBe(11);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('item_links');
    expect(tables).toContain('disclosure_grants');
  });

  it('非空迁移 10 库副本升级到 11 且幂等：空归属保持 unassigned，有项目的为 project', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'ixaeon-m10-'));
    const oldDbPath = join(oldDir, 'old.db');
    const old = openDatabase(oldDbPath);
    migrate(old, 10);
    expect(currentMigrationVersion(old)).toBe(10);
    const now = new Date().toISOString();
    old
      .prepare(
        'INSERT INTO permissions (id, scope_type, locator, mode, status, granted_at) VALUES (?,?,?,?,?,?)',
      )
      .run('p1', 'file', 'C:/tmp/a.md', 'once', 'active', now);
    const pid = crypto.randomUUID();
    old
      .prepare(
        'INSERT INTO projects (id, name, root_path, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(pid, '已有项目', null, null, 'active', now, now);
    const withProject = crypto.randomUUID();
    const unassigned = crypto.randomUUID();
    old
      .prepare(
        `INSERT INTO items (id, project_id, type, statement, state, confidence, origin, created_at, updated_at, needs_review)
         VALUES (?, ?, 'goal', '项目目标', 'current', 1, 'user', ?, ?, 0)`,
      )
      .run(withProject, pid, now, now);
    old
      .prepare(
        `INSERT INTO items (id, project_id, type, statement, state, confidence, origin, created_at, updated_at, needs_review)
         VALUES (?, NULL, 'preference', '未整理偏好', 'current', 1, 'user', ?, ?, 0)`,
      )
      .run(unassigned, now, now);
    old.close();

    const upgraded = openDatabase(oldDbPath);
    migrate(upgraded);
    expect(currentMigrationVersion(upgraded)).toBe(11);
    migrate(upgraded);
    expect(currentMigrationVersion(upgraded)).toBe(11);
    const a = upgraded.prepare('SELECT scope FROM items WHERE id = ?').get(withProject) as {
      scope: string;
    };
    const b = upgraded.prepare('SELECT scope FROM items WHERE id = ?').get(unassigned) as {
      scope: string;
    };
    expect(a.scope).toBe('project');
    expect(b.scope).toBe('unassigned');
    upgraded.close();
    rmSync(oldDir, { recursive: true, force: true });
  });
});

describe('A01 无项目也能开始', () => {
  it('空项目列表可导入个人资料、形成个人候选、不强迫创建「我」项目', async () => {
    expect(projects.list()).toHaveLength(0);
    const file = join(dir, 'personal.md');
    writeFileSync(file, '# 个人笔记\n我想做一个本地优先的助手。\n', 'utf8');
    const created = imports.importFile(file, {
      projectId: null,
      permissionId: perms.grantFile(file).id,
    }).created[0]!;
    expect(created.project_id).toBeNull();
    // 空项目列表下形成个人候选（不强迫创建「我」项目）
    const candidate = items.createManual({
      projectId: null,
      type: 'goal',
      statement: '做一个本地优先的个人助手',
      rationale: '来自个人笔记',
    });
    expect(candidate.scope).toBe('unassigned');
    expect(candidate.project_id).toBeNull();
    const personal = items.setScope(candidate.id, 'personal');
    expect(personal.scope).toBe('personal');
    expect(personal.project_id).toBeNull();
    expect(projects.list()).toHaveLength(0);
  });
});

describe('A02 范围与待处理原因', () => {
  it('personal 不产生 no_project；unassigned 仍产生；改范围只清自己负责原因', () => {
    expect(
      [...derivedNeedsReasons({
        project_id: null,
        scope: 'personal',
        type: 'goal',
        origin: 'user',
        state: 'current',
        confirmation: 'none',
      })],
    ).not.toContain('no_project');
    expect(
      [...derivedNeedsReasons({
        project_id: null,
        scope: 'unassigned',
        type: 'goal',
        origin: 'user',
        state: 'current',
        confirmation: 'none',
      })],
    ).toContain('no_project');

    const item = items.createManual({
      projectId: null,
      type: 'goal',
      statement: '未整理目标',
      rationale: null,
    });
    expect(item.scope).toBe('unassigned');
    expect(item.needs_review).toBe(true);

    items.setPendingReview(item.id, true);
    const withManual = items.get(item.id);
    expect(withManual.needs_review).toBe(true);

    const personal = items.setScope(item.id, 'personal');
    expect(personal.scope).toBe('personal');
    // manual 原因保留
    expect(personal.needs_review).toBe(true);
    const reasons = (
      db.prepare('SELECT needs_reasons FROM items WHERE id = ?').get(item.id) as { needs_reasons: string }
    ).needs_reasons;
    expect(reasons.split(',')).toContain('manual');
    expect(reasons.split(',')).not.toContain('no_project');
  });

  it('superseded 条目不能改范围复活', () => {
    const item = items.createManual({
      projectId: null,
      type: 'preference',
      statement: '旧偏好',
      rationale: null,
      scope: 'personal',
    });
    items.correct({ itemId: item.id, userText: '新偏好' });
    expect(() => items.setScope(item.id, 'unassigned')).toThrow(/已被替代/);
    expect(items.get(item.id).state).toBe('superseded');
  });
});

describe('A11 编码客户端不泄露未分享个人资料', () => {
  it('无项目搜索与 item 摘录默认排除 personal；分享后可见；撤权立即失效', () => {
    const personal = items.createManual({
      projectId: null,
      type: 'constraint',
      statement: '我的私人健康约束绝不外发',
      rationale: null,
      scope: 'personal',
    });
    const project = projects.create({ name: '公开项目', rootPath: null, description: null });
    const publicItem = items.createManual({
      projectId: project.id,
      type: 'goal',
      statement: '公开项目目标',
      rationale: null,
    });
    expect(publicItem.scope).toBe('project');

    const hidden = mcp.searchContext({ query: '私人健康', limit: 8 });
    expect(hidden.results.some((r) => r.ref === personal.id)).toBe(false);

    const shown = mcp.searchContext({ query: '公开项目目标', limit: 8 });
    expect(shown.results.some((r) => r.ref === publicItem.id)).toBe(true);

    expect(() => mcp.getSourceExcerpt(personal.id, 200)).toThrow(/未获准分享|SCOPE_DENIED|IXA0024/);

    const grant = items.grantDisclosure({
      itemId: personal.id,
      audience: 'coding_client',
      note: '仅此任务',
    });
    const excerpt = mcp.getSourceExcerpt(personal.id, 200);
    expect(excerpt.excerpt).toContain('私人健康');
    const afterGrant = mcp.searchContext({ query: '私人健康', limit: 8 });
    expect(afterGrant.results.some((r) => r.ref === personal.id)).toBe(true);

    items.revokeDisclosure(grant.id);
    expect(() => mcp.getSourceExcerpt(personal.id, 200)).toThrow(/未获准分享|SCOPE_DENIED|IXA0024/);
    expect(ErrorCodes.SCOPE_DENIED).toBe('IXA0024');
  });
});

describe('A12 导出包含新表', () => {
  it('人类可读 JSON 含 item_links 与 disclosure_grants', async () => {
    const personal = items.createManual({
      projectId: null,
      type: 'goal',
      statement: '个人长期目标',
      rationale: null,
      scope: 'personal',
    });
    const project = projects.create({ name: '关联项目', rootPath: null, description: null });
    items.addLink({ itemId: personal.id, kind: 'project', targetId: project.id });
    items.grantDisclosure({ itemId: personal.id, audience: 'coding_client' });

    const vault = new Vault(join(dir, 'vault'));
    const archive = new ArchiveService(db, {
      dataDir: dir,
      dbPath: join(dir, 'ixaeon.db'),
      vault,
      closeCurrentDb: () => {},
    });
    const zipPath = join(dir, 's1-export.zip');
    const result = await archive.exportData(zipPath);
    expect(existsSync(result.zipPath)).toBe(true);

    const JSZip = (await import('jszip')).default;
    const { readFileSync } = await import('node:fs');
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    expect(zip.file('data/item-links.json')).toBeTruthy();
    expect(zip.file('data/disclosure-grants.json')).toBeTruthy();
    const links = JSON.parse(await zip.file('data/item-links.json')!.async('string')) as {
      count: number;
    };
    const grants = JSON.parse(await zip.file('data/disclosure-grants.json')!.async('string')) as {
      count: number;
    };
    expect(links.count).toBe(1);
    expect(grants.count).toBe(1);
  });
});
