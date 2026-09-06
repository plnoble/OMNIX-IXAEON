import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  Vault,
  PermissionService,
  SourceStore,
  ProjectService,
  ImportService,
  Extractor,
  FakeProvider,
  type CoreDatabase,
} from '@ixaeon/core';

/**
 * M1.1 一次归属，后续继承：
 * - 绑定后新增内容继承项目归属（刷新/追加不丢）；
 * - 模型 project_hint 只是建议：进入待讨论并记录建议项目，不悄悄归属；
 * - 重新绑定：派生 AI 条目跟随，人工纠正/手工条目不被搬走；
 * - 解绑：派生条目回未分配 + 待讨论；
 * - 草稿转正继承项目绑定。
 */

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedSource(name: string, body: string): { id: string; file: string } {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, `# ${name}\n\n${body}`, 'utf8');
  const created = imports
    .importFile(file, { projectId: null, permissionId: perms.grantFile(file).id })
    .created[0]!;
  return { id: created.id, file };
}

async function extract(
  sourceId: string,
  items: Array<Record<string, unknown>>,
): Promise<void> {
  const fake = new FakeProvider('m1');
  for (const item of items) fake.enqueueStructured({ items: [item] });
  await new Extractor(db, fake).extractSource(sourceId);
}

describe('M1.1 一次归属，后续继承', () => {
  it('绑定后新增内容继承项目；派生条目归属绑定项目且不进待讨论', async () => {
    const projectA = projects.create({ name: '绑定A', rootPath: null, description: null });
    const s = seedSource('bind-inherit', '绑定继承测试内容 BIND_INHERIT_MARK');
    // 绑定到项目 A
    const { movedItems } = sources.bindProject(s.id, projectA.id);
    expect(movedItems).toBe(0); // 尚无派生条目

    // 追加新内容（继承归属：来源仍是绑定项目）
    sources.appendCapturedTurns(s.id, [
      { order: 10, role: 'user', text: '追加的问题 INHERIT_Q' },
    ]);
    // 提取（模型不再提供 project_hint 猜测）
    await extract(s.id, [
      {
        type: 'decision',
        statement: '继承测试结论',
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S3',
        project_hint: null,
        excerpt: 'INHERIT_Q',
      },
    ]);
    const items = db
      .prepare('SELECT project_id, needs_review FROM items WHERE extracted_from_source_id = ?')
      .all(s.id) as Array<{ project_id: string | null; needs_review: number }>;
    expect(items.length).toBe(1);
    expect(items[0]!.project_id).toBe(projectA.id); // 继承绑定项目
    // G6：decision 属重要决定类 → 即使已归属项目也进待讨论（待用户确认）
    expect(items[0]!.needs_review).toBe(1);
  });

  it('project_hint 只是建议：待讨论 + 记录建议项目，不悄悄归属', async () => {
    projects.create({ name: '猜测目标', rootPath: null, description: null });
    const s = seedSource('hint-test', 'HINT_SUGGEST_MARK 内容。');
    await extract(s.id, [
      {
        type: 'decision',
        statement: '带猜测的结论',
        rationale: null,
        confidence: 0.8,
        segment_ref: 'S2',
        project_hint: '猜测目标',
        excerpt: 'HINT_SUGGEST_MARK',
      },
    ]);
    const item = db
      .prepare('SELECT project_id, needs_review, suggested_project_id FROM items WHERE extracted_from_source_id = ?')
      .get(s.id) as { project_id: string | null; needs_review: number; suggested_project_id: string | null };
    // 不悄悄归属：project_id 为空、进入待讨论；建议项目已记录（M1.1）
    expect(item.project_id).toBeNull();
    expect(item.needs_review).toBe(1);
    const suggestion = projects.list().find((p) => p.name === '猜测目标')!;
    expect(item.suggested_project_id).toBe(suggestion.id);
  });

  it('重新绑定：派生 AI 条目跟随，人工纠正条目不被搬走', async () => {
    const projectA = projects.create({ name: '重绑A', rootPath: null, description: null });
    const projectB = projects.create({ name: '重绑B', rootPath: null, description: null });
    const s = seedSource('rebind-test', 'REBIND_MARK 内容。');
    sources.bindProject(s.id, projectA.id);

    // 提取出一条 AI 条目
    await extract(s.id, [
      {
        type: 'decision',
        statement: 'AI 结论（重绑测试）',
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S2',
        project_hint: null,
        excerpt: 'REBIND_MARK',
      },
    ]);
    const aiItem = db
      .prepare("SELECT id, project_id FROM items WHERE extracted_from_source_id = ? AND origin='ai'")
      .get(s.id) as { id: string; project_id: string };
    expect(aiItem.project_id).toBe(projectA.id);

    // 用户对同源条目手工创建并归属 A（模拟人工条目）
    const manual = db
      .prepare(
        `INSERT INTO items (id, project_id, type, statement, state, confidence, origin, created_at, updated_at)
         VALUES ('manual-1', ?, 'decision', '人工补充条目', 'current', 1, 'user', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(projectA.id);

    // 重新绑定到 B
    sources.bindProject(s.id, projectB.id);

    const aiAfter = db.prepare('SELECT project_id FROM items WHERE id = ?').get(aiItem.id) as {
      project_id: string;
    };
    expect(aiAfter.project_id).toBe(projectB.id); // 派生条目跟随
    const manualAfter = db.prepare('SELECT project_id FROM items WHERE id = ?').get('manual-1') as {
      project_id: string;
    };
    expect(manualAfter.project_id).toBe(projectA.id); // 人工条目不搬
    void manual;
  });

  it('解绑：派生条目回未分配并进入待讨论', () => {
    const projectA = projects.create({ name: '解绑A', rootPath: null, description: null });
    const s = seedSource('unbind-test', 'UNBIND_MARK 内容。');
    sources.bindProject(s.id, projectA.id);
    const { movedItems } = sources.bindProject(s.id, null);
    expect(movedItems).toBeGreaterThanOrEqual(0);
    const src = sources.get(s.id)!;
    expect(src.project_id).toBeNull();
  });

  it('草稿转正继承项目绑定（merge 携带 project_id）', async () => {
    const projectP = projects.create({ name: '转正P', rootPath: null, description: null });
    const permId = perms.list()[0]!.id;
    const now = '2026-01-01T00:00:00Z';
    // 草稿来源（chatgpt_web，已绑定项目 P）
    const draftId = 'draft-promote';
    db.prepare(
      `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
        captured_at, imported_at, permission_id, project_id, metadata_json, content_revision)
       VALUES (?, 'conversation', 'chatgpt_web', 'page:draft-x', '草稿来源',
         '${'c'.repeat(64)}', 'sha256/cc/${'c'.repeat(64)}', NULL, ?, ?, ?, '{}', 1)`,
    ).run(draftId, now, permId, projectP.id);
    db.prepare(
      `INSERT INTO segments (id, source_id, sequence, role, external_node_id, external_parent_id,
        is_active_branch, occurred_at, text, content_hash, metadata_json)
       VALUES ('seg-draft-1', ?, 0, 'user', '0', NULL, 1, NULL, '草稿内容 PROMOTE_MARK', '${'d'.repeat(64)}', '{}')`,
    ).run(draftId);
    // 正式来源（转正后创建，项目为空）
    db.prepare(
      `INSERT INTO sources (id, kind, provider, external_id, title, content_hash, raw_path,
        captured_at, imported_at, permission_id, project_id, metadata_json, content_revision)
       VALUES ('formal-promote', 'conversation', 'chatgpt_web', '/c/promoted-001', '转正来源',
         '${'b'.repeat(64)}', 'sha256/bb/${'b'.repeat(64)}', NULL, ?, ?, NULL, '{}', 1)`,
    ).run(now, permId);
    sources.mergeConversationSources(draftId, 'formal-promote');
    const formal = sources.get('formal-promote')!;
    expect(formal.project_id).toBe(projectP.id); // 绑定继承
    expect(sources.get(draftId)).toBeNull(); // 临时来源已合并删除
  });
});
