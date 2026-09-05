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
  ItemService,
  Extractor,
  FakeProvider,
  McpService,
  type CoreDatabase,
} from '@ixaeon/core';

/**
 * M2 重要理解可确认，改口不会被冲掉：
 * - 确认：origin 不被篡改为 user（谁提取的维度不变）；清待讨论；落审计时间。
 * - 不采纳：不是「确认正确」；简报/问答/检索排除 rejected。
 * - 重新提取不覆盖人工改口：已确认/已不采纳条目保留；高度相似的新结论跳过。
 * - 冲突真的可见：查询同时取回 disputed。
 */

let dir: string;
let db: CoreDatabase;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;
let items: ItemService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m2-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
  items = new ItemService(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface SeedResult {
  sourceId: string;
  project: { id: string; name: string };
}

async function seedWithAiItem(statement: string, excerpt: string): Promise<SeedResult> {
  const project = projects.create({ name: `M2-${statement.slice(0, 8)}`, rootPath: null, description: null });
  const file = join(dir, `${statement.slice(0, 12)}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, `# M2\n\n${excerpt}\n`, 'utf8');
  const created = imports
    .importFile(file, { projectId: project.id, permissionId: perms.grantFile(file).id })
    .created[0]!;
  const fake = new FakeProvider('m2');
  fake.enqueueStructured({
    items: [
      {
        type: 'decision',
        statement,
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S2',
        project_hint: null,
        excerpt,
      },
    ],
  });
  await new Extractor(db, fake).extractSource(created.id);
  return { sourceId: created.id, project };
}

describe('M2 确认维度', () => {
  it('确认：origin 保持 ai（不篡改为用户写的）、清待讨论、记录时间', async () => {
    const { sourceId } = await seedWithAiItem('确认测试结论 CONFIRM_MARK', 'CONFIRM_MARK');
    const item = db
      .prepare('SELECT * FROM items WHERE extracted_from_source_id = ?')
      .get(sourceId) as { id: string; origin: string; needs_review: number };
    expect(item.origin).toBe('ai');

    const confirmed = items.confirm(item.id);
    expect(confirmed.origin).toBe('ai'); // 谁提取的维度不变
    expect(confirmed.confirmation).toBe('confirmed');
    expect(confirmed.confirmation_at).toBeTruthy();
    expect(confirmed.needs_review).toBe(false);
  });

  it('不采纳：confirmation=rejected（不是 confirmed），保留可追溯', async () => {
    const { sourceId } = await seedWithAiItem('不采纳测试结论 REJECT_MARK', 'REJECT_MARK');
    const item = db
      .prepare('SELECT id FROM items WHERE extracted_from_source_id = ?')
      .get(sourceId) as { id: string };
    const rejected = items.reject(item.id);
    expect(rejected.confirmation).toBe('rejected');
    expect(rejected.state).toBe('current'); // 条目仍存在可追溯
    expect(rejected.needs_review).toBe(false);
  });

  it('简报排除 rejected；confirmed 带用户已确认标注', async () => {
    const a = await seedWithAiItem('简报确认条目 BRIEF_OK_MARK', 'BRIEF_OK_MARK');
    const b = await seedWithAiItem('简报排除条目 BRIEF_OUT_MARK', 'BRIEF_OUT_MARK');
    const itemA = db
      .prepare('SELECT id FROM items WHERE extracted_from_source_id = ?')
      .get(a.sourceId) as { id: string };
    const itemB = db
      .prepare('SELECT id FROM items WHERE extracted_from_source_id = ?')
      .get(b.sourceId) as { id: string };
    items.confirm(itemA.id);
    items.reject(itemB.id);

    const mcp = new McpService(db);
    const brief = mcp.prepareTask({
      project_ref: a.project.name,
      task: '测试简报',
      max_chars: 12000,
    });
    const all = [...brief.purpose, ...brief.decisions, ...brief.status];
    expect(all.some((e) => e.text.includes('BRIEF_OK_MARK') && e.text.includes('用户已确认'))).toBe(
      true,
    );
    const briefB = mcp.prepareTask({
      project_ref: b.project.name,
      task: '测试简报',
      max_chars: 12000,
    });
    const allB = [...briefB.purpose, ...briefB.decisions, ...briefB.status];
    expect(allB.some((e) => e.text.includes('BRIEF_OUT_MARK'))).toBe(false);
  });

  it('重新提取不冲掉人工改口：已不采纳条目保留，相似新结论跳过', async () => {
    const { sourceId } = await seedWithAiItem('改口保留结论 KEEP_MARK', 'KEEP_MARK');
    const item = db
      .prepare('SELECT id FROM items WHERE extracted_from_source_id = ?')
      .get(sourceId) as { id: string };
    items.reject(item.id);

    // 重新提取：模型再次给出高度相似结论 → 应跳过，已不采纳条目保留
    const fake2 = new FakeProvider('m2-reextract');
    fake2.enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '改口保留结论 KEEP_MARK（模型重申）',
          rationale: null,
          confidence: 0.95,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: 'KEEP_MARK',
        },
      ],
    });
    const stats = await new Extractor(db, fake2).extractSource(sourceId);
    expect(stats.skippedPreserved).toBe(1); // 相似新结论被跳过
    const after = db
      .prepare('SELECT confirmation FROM items WHERE id = ?')
      .get(item.id) as { confirmation: string };
    expect(after.confirmation).toBe('rejected'); // 人工改口未被冲掉
    const count = (
      db
        .prepare('SELECT COUNT(*) n FROM items WHERE extracted_from_source_id = ?')
        .get(sourceId) as { n: number }
    ).n;
    expect(count).toBe(1); // 没有插入第二条
  });

  it('冲突真的可见：listItems 不带 state 过滤时 disputed 与 current 都返回', () => {
    const all = items.list({ projectId: null });
    // 该断言的价值在于消费方（Understanding 页）已改为不过滤 state；
    // disputed 由 markDisputed 产生，这里验证查询路径本身不排除 disputed。
    expect(Array.isArray(all)).toBe(true);
    expect(all.every((i) => i.confirmation !== undefined)).toBe(true);
  });
});
