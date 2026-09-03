import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ImportService,
  ProjectService,
  SearchService,
  sha256,
} from '../../src/index.js';
import {
  fixturePath,
  readonlyThoughtDocs,
  makeConversationsJson,
  makeFakeConversation,
} from '@ixaeon/test-fixtures';
import type { CoreDatabase } from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let permissions: PermissionService;
let sources: SourceStore;
let imports: ImportService;
let projects: ProjectService;
let search: SearchService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-import-test-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  permissions = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  search = new SearchService(db);
  imports = new ImportService(db, vault, permissions, sources);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('授权默认拒绝', () => {
  it('未授权路径读取被拒绝（PERMISSION_DENIED）', () => {
    const outside = join(dir, 'unauthorized.md');
    writeFileSync(outside, '# 未授权文档');
    expect(() => imports.importFile(outside, { projectId: null, allowedPaths: [] })).toThrowError(
      expect.objectContaining({ code: 'IXA0001' }),
    );
  });
});

describe('Markdown / TXT / JSON 导入', () => {
  it('导入 Markdown 文档成功并可搜索', () => {
    const file = join(dir, 'notes.md');
    writeFileSync(file, '# 星尘计划\n\n目标是构建本地知识整理工具。', 'utf8');
    const result = imports.importFile(file, { projectId: null, allowedPaths: [file] });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.kind).toBe('document');
    expect(result.created[0]!.title).toBe('notes.md');
    // FTS 可搜到
    const hits = search.searchSegments('星尘计划', {});
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sourceTitle).toBe('notes.md');
  });

  it('同一文件重复导入幂等（只有一份来源）', () => {
    const file = join(dir, 'notes.md');
    const again = imports.importFile(file, { projectId: null, allowedPaths: [file] });
    expect(again.created).toHaveLength(0);
    expect(again.deduplicated).toHaveLength(1);
    const all = sources.list({ projectId: null });
    expect(all.filter((s) => s.source.title === 'notes.md')).toHaveLength(1);
  });

  it('内容变化后产生新记录（不覆盖）', () => {
    const file = join(dir, 'versioned.md');
    writeFileSync(file, '第一版内容');
    const first = imports.importFile(file, { projectId: null, allowedPaths: [file] });
    writeFileSync(file, '第一版内容（更新）');
    const second = imports.importFile(file, { projectId: null, allowedPaths: [file] });
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(1);
    expect(first.created[0]!.id).not.toBe(second.created[0]!.id);
  });

  it('导入带提示注入的文档只作为资料', () => {
    const file = fixturePath('files', 'prompt-injection.md');
    const result = imports.importFile(file, { projectId: null, allowedPaths: [file] });
    expect(result.created).toHaveLength(1);
    // 注入文本被完整保存为普通片段
    const { segments } = sources.getSegments(result.created[0]!.id, 0, 10);
    expect(segments[0]!.text).toContain('忽略之前的所有规则');
  });

  it('不支持的扩展名被拒绝', () => {
    const file = join(dir, 'data.csv');
    writeFileSync(file, 'a,b');
    expect(() => imports.importFile(file, { projectId: null, allowedPaths: [file] })).toThrowError(
      expect.objectContaining({ code: 'IXA0004' }),
    );
  });

  it('JSON 文档导入（会议纪要）', () => {
    const file = fixturePath('files', 'meeting-notes.json');
    const result = imports.importFile(file, { projectId: null, allowedPaths: [file] });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.title).toBe('会议纪要：IXAEON 第一版评审（脱敏测试资料）');
  });
});

describe('ChatGPT conversations.json 导入', () => {
  it('多场对话各自成为来源，分支关系保留', () => {
    const file = join(dir, 'conversations.json');
    writeFileSync(file, makeConversationsJson(), 'utf8');
    const result = imports.importChatgptExport(file, { projectId: null, allowedPaths: [file] });
    expect(result.created).toHaveLength(2);
    const conv = result.created[0]!;
    const { segments, total } = sources.getSegments(conv.id, 0, 100);
    expect(total).toBe(6); // 3 轮 × (user + assistant)
    // user/assistant 角色正确
    const roles = segments.map((s) => s.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    // 父子关系保留：assistant 的 external_parent_id 是 user 节点
    const firstAssistant = segments[1]!;
    expect(firstAssistant.external_parent_id).toBe(segments[0]!.external_node_id);
  });

  it('重复导入同一导出包幂等', () => {
    const file = join(dir, 'conversations.json');
    const again = imports.importChatgptExport(file, { projectId: null, allowedPaths: [file] });
    expect(again.created).toHaveLength(0);
    expect(again.deduplicated).toHaveLength(2);
  });

  it('非活动分支被标记且默认不参与提取候选', () => {
    const file = join(dir, 'conversations-branched.json');
    writeFileSync(
      file,
      JSON.stringify([makeFakeConversation({ title: '带分支对话', turns: 2, withInactiveBranch: true })]),
      'utf8',
    );
    const result = imports.importChatgptExport(file, { projectId: null, allowedPaths: [file] });
    expect(result.created).toHaveLength(1);
    const { segments } = sources.getSegments(result.created[0]!.id, 0, 100);
    const inactive = segments.filter((s) => !s.is_active_branch);
    const active = segments.filter((s) => s.is_active_branch);
    expect(inactive).toHaveLength(1);
    expect(inactive[0]!.text).toContain('被重新生成替代的旧回答');
    expect(active.length).toBe(4); // 2 轮 × 2
  });
});

describe('项目目录快照', () => {
  it('只读说明与配置文件，排除敏感文件', () => {
    const projDir = join(dir, 'my-project');
    mkdirSync(join(projDir, 'docs'), { recursive: true });
    writeFileSync(join(projDir, 'README.md'), '# 我的项目\n说明文字。');
    writeFileSync(join(projDir, 'AGENTS.md'), '编码代理须知。');
    writeFileSync(join(projDir, 'package.json'), '{"name":"my-project"}');
    writeFileSync(join(projDir, 'docs', 'design.md'), '# 设计\n文档内容。');
    writeFileSync(join(projDir, '.env'), 'SECRET=1');
    writeFileSync(join(projDir, 'id_rsa'), 'FAKE KEY');
    writeFileSync(join(projDir, 'cookie.json'), '{"c":1}');
    mkdirSync(join(projDir, 'node_modules'), { recursive: true });
    writeFileSync(join(projDir, 'node_modules', 'dep.js'), 'require("x")');
    mkdirSync(join(projDir, 'src'), { recursive: true });
    writeFileSync(join(projDir, 'src', 'main.ts'), 'console.log(1)');

    const project = projects.create({ name: '快照测试项目', rootPath: projDir, description: null });
    const result = imports.importProjectSnapshot(projDir, { projectId: project.id });
    expect(result.created).toHaveLength(1);
    const snapshot = result.created[0]!;
    expect(snapshot.project_id).toBe(project.id);

    const { segments } = sources.getSegments(snapshot.id, 0, 100);
    const texts = segments.map((s) => s.text);
    const joined = texts.join('\n');
    expect(joined).toContain('我的项目');
    expect(joined).toContain('编码代理须知');
    expect(joined).toContain('"name":"my-project"');
    expect(joined).toContain('设计');
    // 敏感与源码文件绝不读取
    expect(joined).not.toContain('SECRET=1');
    expect(joined).not.toContain('FAKE KEY');
    expect(joined).not.toContain('{"c":1}');
    expect(joined).not.toContain('console.log(1)');
    expect(joined).not.toContain('require("x")');
  });
});

describe('真实思想文档导入（计划 10.1 的基础）', () => {
  it('根目录两份 Markdown 可导入且可全文检索', () => {
    for (const doc of readonlyThoughtDocs()) {
      const result = imports.importFile(doc, { projectId: null, allowedPaths: [doc] });
      expect(result.created).toHaveLength(1);
      expect(result.created[0]!.content_hash).toHaveLength(64);
    }
    const hits = search.searchSegments('IXAEON', {});
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('扩展增量提交（chatgpt_web）', () => {
  it('追加轮次：新内容入库，重复内容去重，编辑保存为新版本', () => {
    // 先建立 chatgpt_web 来源（模拟配对后首批）
    const perm = permissions.grantDomain('chatgpt.com');
    const now = new Date().toISOString();
    const sourceId = randomUUID();
    db.prepare(
      `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
        captured_at, imported_at, permission_id, project_id, metadata_json)
       VALUES (?, 'conversation', 'chatgpt_web', '/c/abc', '网页对话', ?, 'sha256/aa/aaa', ?, ?, ?, NULL, '{}')`,
    ).run(sourceId, sha256('init'), now, now, perm.id);

    const r1 = sources.appendCapturedTurns(sourceId, [
      { order: 0, role: 'user', text: '你好，介绍一下 IXAEON' },
      { order: 1, role: 'assistant', text: 'IXAEON 是正式系统名，中文名是析衍。' },
    ]);
    expect(r1.accepted).toBe(2);
    expect(r1.deduplicated).toBe(0);

    // 刷新后重发全部：全部去重
    const r2 = sources.appendCapturedTurns(sourceId, [
      { order: 0, role: 'user', text: '你好，介绍一下 IXAEON' },
      { order: 1, role: 'assistant', text: 'IXAEON 是正式系统名，中文名是析衍。' },
    ]);
    expect(r2.accepted).toBe(0);
    expect(r2.deduplicated).toBe(2);

    // 新一轮追加
    const r3 = sources.appendCapturedTurns(sourceId, [
      { order: 0, role: 'user', text: '你好，介绍一下 IXAEON' },
      { order: 1, role: 'assistant', text: 'IXAEON 是正式系统名，中文名是析衍。' },
      { order: 2, role: 'user', text: '它的核心价值是什么？' },
      { order: 3, role: 'assistant', text: '项目连续性。' },
    ]);
    expect(r3.accepted).toBe(2);
    expect(r3.deduplicated).toBe(2);

    // 回答被编辑（同顺序不同内容）→ 新版本，不覆盖
    const r4 = sources.appendCapturedTurns(sourceId, [
      { order: 0, role: 'user', text: '你好，介绍一下 IXAEON' },
      { order: 1, role: 'assistant', text: 'IXAEON（析衍）是 OMNIX 的项目记忆系统。' },
    ]);
    expect(r4.accepted).toBe(1);
    const { segments } = sources.getSegments(sourceId, 0, 100);
    const order1 = segments.filter((s) => s.external_node_id === '1');
    expect(order1).toHaveLength(2); // 旧版本 + 新版本都保留
    const texts = order1.map((s) => s.text);
    expect(texts).toContain('IXAEON 是正式系统名，中文名是析衍。');
    expect(texts).toContain('IXAEON（析衍）是 OMNIX 的项目记忆系统。');
  });
});
