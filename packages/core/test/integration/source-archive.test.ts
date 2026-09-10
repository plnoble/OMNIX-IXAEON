import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  Extractor,
  FakeProvider,
  AskService,
  buildPersonalOverview,
  type CoreDatabase,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let vault: Vault;
let permissions: PermissionService;
let sources: SourceStore;
let imports: ImportService;
let items: ItemService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-archive-src-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  vault = new Vault(join(dir, 'vault'));
  permissions = new PermissionService(db);
  sources = new SourceStore(db);
  imports = new ImportService(db, vault, permissions, sources);
  items = new ItemService(db);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('来源归档（短经验摘要）', () => {
  it('迁移 17 增加 archived_at / archive_summary', () => {
    expect(currentMigrationVersion(db)).toBeGreaterThanOrEqual(17);
    const cols = (db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('archived_at');
    expect(cols).toContain('archive_summary');
  });

  it('归档：停提取、退出待讨论、留下经验摘要；原文仍可检索', async () => {
    const doc = join(dir, 'old-work.md');
    writeFileSync(
      doc,
      ['# 登录方案', '', '当时用会话 cookie 做登录，后来改成 token。'].join('\n'),
      'utf8',
    );
    const source = imports.importFile(doc, {
      projectId: null,
      permissionId: permissions.grantFile(doc).id,
    }).created[0]!;

    const fake = new FakeProvider('fake-archive');
    fake.enqueueStructured({
      items: [
        {
          type: 'goal',
          statement: '要把登录改成现行目标',
          rationale: null,
          confidence: 0.8,
          segment_ref: 'S2',
          project_hint: null,
          excerpt: '当时用会话 cookie 做登录，后来改成 token。',
        },
      ],
    });
    await new Extractor(db, fake).extractSource(source.id);
    const pendingBefore = items.list({ projectId: null, needsReview: true, shelved: false });
    expect(pendingBefore.some((i) => i.extracted_from_source_id === source.id)).toBe(true);

    const drafted = sources.composeArchiveSummary(source.id);
    const result = sources.archive(source.id, drafted);
    expect(result.summary).toContain('登录方案');
    expect(sources.isArchived(source.id)).toBe(true);

    const pendingAfter = items.list({ projectId: null, needsReview: true, shelved: false });
    expect(pendingAfter.some((i) => i.extracted_from_source_id === source.id)).toBe(false);

    const overview = buildPersonalOverview(db);
    expect(overview.unknowns.some((i) => i.extracted_from_source_id === source.id)).toBe(false);

    await expect(new Extractor(db, new FakeProvider()).extractSource(source.id)).rejects.toThrow(
      /已归档/,
    );

    const summaries = items.list({ projectId: null, type: 'project_summary', shelved: false });
    const exp = summaries.find((i) => i.extracted_from_source_id === source.id);
    expect(exp?.origin).toBe('ai');
    expect(exp?.rationale).toMatch(/归档经验摘要/);
    expect(exp?.needs_review).toBe(false);

    const ask = new AskService(db, new FakeProvider('ask'));
    const fakeAsk = ask as AskService & { provider: FakeProvider };
    void fakeAsk;
    const provider = new FakeProvider('ask');
    provider.enqueueText('过往用 cookie 后来改 token [R1]');
    const answer = await new AskService(db, provider).ask(null, '登录怎么做过');
    expect(answer.answer.length).toBeGreaterThan(0);
    expect(provider.textCalls[0]!.user).toMatch(/过往工作档案|经验/);

    sources.unarchive(source.id);
    expect(sources.isArchived(source.id)).toBe(false);
  });

  it('composeArchiveSummary 无模型也能生成一句', () => {
    const doc = join(dir, 'note.md');
    writeFileSync(doc, '这是一句过往经验正文。', 'utf8');
    const source = imports.importFile(doc, {
      projectId: null,
      permissionId: permissions.grantFile(doc).id,
    }).created[0]!;
    const summary = sources.composeArchiveSummary(source.id);
    expect(summary).toMatch(/过往工作/);
    expect(summary.length).toBeGreaterThan(4);
    expect(summary.length).toBeLessThanOrEqual(400);
  });
});
