import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
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
  parseChatgptConversations,
  type CoreDatabase,
} from '../../src/index.js';
import { makeFakeConversation } from '@ixaeon/test-fixtures';

/**
 * S2 多来源输入与项目目录：A05（ChatGPT 规范化 + 跨账号不合并）/ A07（多项目登记）。
 * Gemini / Grok / Claude 无脱敏样本，本文件明确不写伪解析器。
 */

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;
let perms: PermissionService;
let sources: SourceStore;
let imports: ImportService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s2-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('A05 ChatGPT 规范化结构', () => {
  it('全新库迁移版本为 12', () => {
    expect(currentMigrationVersion(db)).toBeGreaterThanOrEqual(12);
  });

  it('保存平台、命名空间、对话标识、说话人、消息标识、父子、时间、导入方式', () => {
    const file = join(dir, 'conversations.json');
    writeFileSync(
      file,
      JSON.stringify([makeFakeConversation({ title: '命名空间测试', turns: 2 })]),
      'utf8',
    );
    const result = imports.importChatgptExport(file, {
      projectId: null,
      permissionId: perms.grantFile(file).id,
      accountNamespace: 'work-acct',
    });
    expect(result.created).toHaveLength(1);
    const src = result.created[0]!;
    expect(src.account_namespace).toBe('work-acct');
    expect(src.provider).toBe('chatgpt_export');
    const meta = JSON.parse(src.metadata_json) as {
      platform: string;
      account_namespace: string;
      import_method: string;
      missing_fields: string[];
      unparsed_attachments: number;
    };
    expect(meta.platform).toBe('chatgpt');
    expect(meta.account_namespace).toBe('work-acct');
    expect(meta.import_method).toBe('history_export');
    expect(meta.missing_fields).toEqual([]);
    const { segments } = sources.getSegments(src.id, 0, 20);
    expect(segments[0]!.role).toBe('user');
    expect(segments[0]!.external_node_id).toBeTruthy();
    expect(segments[1]!.external_parent_id).toBe(segments[0]!.external_node_id);
    expect(segments[0]!.occurred_at).toBeTruthy();
  });

  it('跨账户相同对话 ID 不合并', () => {
    const conv = makeFakeConversation({ title: '同一对话', turns: 1 });
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeFileSync(a, JSON.stringify([conv]), 'utf8');
    writeFileSync(b, JSON.stringify([conv]), 'utf8');
    const first = imports.importChatgptExport(a, {
      projectId: null,
      permissionId: perms.grantFile(a).id,
      accountNamespace: 'alice',
    });
    const second = imports.importChatgptExport(b, {
      projectId: null,
      permissionId: perms.grantFile(b).id,
      accountNamespace: 'bob',
    });
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(1);
    expect(first.created[0]!.id).not.toBe(second.created[0]!.id);
    expect(first.created[0]!.external_id).toBe(second.created[0]!.external_id);
  });

  it('同账户再导入相同内容去重；缺 conversation_id 不凭标题合并', () => {
    const file = join(dir, 'conversations.json');
    const conv = makeFakeConversation({ title: '无 ID 对话', turns: 1 });
    delete (conv as { conversation_id?: string }).conversation_id;
    writeFileSync(file, JSON.stringify([conv]), 'utf8');
    const first = imports.importChatgptExport(file, {
      projectId: null,
      permissionId: perms.grantFile(file).id,
    });
    const again = imports.importChatgptExport(file, {
      projectId: null,
      permissionId: perms.grantFile(file).id,
    });
    expect(first.created).toHaveLength(1);
    expect(again.created).toHaveLength(0);
    expect(again.deduplicated).toHaveLength(1);
    const meta = JSON.parse(first.created[0]!.metadata_json) as { missing_fields: string[] };
    expect(meta.missing_fields).toContain('conversation_id');
    expect(first.created[0]!.external_id.startsWith('missing-id:')).toBe(true);

    const other = makeFakeConversation({ title: '无 ID 对话', turns: 1, createTime: 111 });
    delete (other as { conversation_id?: string }).conversation_id;
    const otherFile = join(dir, 'other.json');
    writeFileSync(otherFile, JSON.stringify([other]), 'utf8');
    const secondTitle = imports.importChatgptExport(otherFile, {
      projectId: null,
      permissionId: perms.grantFile(otherFile).id,
    });
    expect(secondTitle.created).toHaveLength(1);
    expect(secondTitle.created[0]!.id).not.toBe(first.created[0]!.id);
  });

  it('非文本附件只记元数据，不声称已理解', () => {
    const conv = makeFakeConversation({ title: '带附件', turns: 1 });
    const userNode = Object.values(conv.mapping).find((n) => n.message?.author.role === 'user');
    expect(userNode).toBeTruthy();
    (userNode!.message!.content.parts as unknown[]).push({ content_type: 'image_asset_pointer' });
    const parsed = parseChatgptConversations([conv], { externalId: '' });
    expect(parsed[0]!.metadata.unparsed_attachments).toBe(1);
    const seg = parsed[0]!.segments.find((s) => s.metadata.unparsed_attachment);
    expect(seg?.metadata.unparsed_note).toMatch(/不声称已理解/);
  });

  it('坏格式文件不影响其他已成功导入', () => {
    const good = join(dir, 'ok.md');
    writeFileSync(good, '# 成功\n内容', 'utf8');
    const created = imports.importFile(good, {
      projectId: null,
      permissionId: perms.grantFile(good).id,
    }).created;
    expect(created).toHaveLength(1);
    const bad = join(dir, 'data.csv');
    writeFileSync(bad, 'a,b', 'utf8');
    expect(() =>
      imports.importFile(bad, { projectId: null, permissionId: perms.grantFile(bad).id }),
    ).toThrow(/不支持的文件类型/);
    expect(sources.list({ projectId: null }).some((s) => s.source.id === created[0]!.id)).toBe(
      true,
    );
  });
});

describe('A07 多项目登记', () => {
  it('一次登记三个项目：两个有目录、一个无目录构想', () => {
    const a = join(dir, 'proj-a');
    const b = join(dir, 'proj-b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, 'README.md'), '# A');
    writeFileSync(join(b, 'README.md'), '# B');
    const created = projects.createMany([
      {
        name: '项目甲',
        rootPath: a,
        description: null,
        purpose: '编码实验',
        currentState: '进行中',
      },
      {
        name: '项目乙',
        rootPath: b,
        description: null,
        purpose: '文档整理',
      },
      {
        name: '长期构想',
        rootPath: null,
        description: '还没有文件夹',
        purpose: '个人助手方向',
        unknowns: '是否需要独立仓库',
      },
    ]);
    expect(created).toHaveLength(3);
    expect(created[2]!.root_path).toBeNull();
    expect(created[0]!.purpose).toBe('编码实验');
    expect(created[2]!.unknowns).toContain('独立仓库');
  });

  it('同目录不凭路径自动合并；导入授权不授予执行权', () => {
    const a = join(dir, 'shared');
    mkdirSync(a);
    writeFileSync(join(a, 'README.md'), '# 只读说明');
    const first = projects.create({ name: '已占用', rootPath: a, description: null });
    expect(() => projects.create({ name: '再占一次', rootPath: a, description: null })).toThrow(
      /已登记/,
    );
    const snap = imports.importProjectSnapshot(a, {
      projectId: first.id,
      permissionId: perms.grantFolder(a).id,
    });
    expect(snap.created).toHaveLength(1);
    // 导入授权只读：permissions 表没有执行类 scope
    const scopes = (
      db.prepare('SELECT DISTINCT scope_type FROM permissions').all() as Array<{
        scope_type: string;
      }>
    ).map((r) => r.scope_type);
    expect(scopes.every((s) => s === 'file' || s === 'folder' || s === 'domain')).toBe(true);
    expect(scopes).not.toContain('execute');
  });

  it('符号链接指向授权范围外被拒绝', () => {
    const inside = join(dir, 'inside');
    const outside = join(dir, 'outside');
    mkdirSync(inside);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.md'), '秘密');
    const link = join(inside, 'escape.md');
    try {
      symlinkSync(join(outside, 'secret.md'), link);
    } catch {
      // Windows 无权限创建符号链接时跳过本断言（与既有 fixes 测试一致）
      return;
    }
    const permission = perms.grantFolder(inside);
    expect(() =>
      imports.importFile(link, { projectId: null, permissionId: permission.id }),
    ).toThrow();
  });
});
