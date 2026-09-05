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
} from '../../src/index.js';

/**
 * M3 编码 AI 的开工与收工闭环：
 * - 开工：简报区分 ai/user/work_result 来源；标注覆盖版本（落后时明示）；
 * - 收工：client_ref 幂等（相同重试去重、同键不同内容冲突）；
 * - 旧客户端不传 client_ref 仍正常（兼容）。
 */

let dir: string;
let db: CoreDatabase;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;
let items: ItemService;
let mcp: McpService;
let project: { id: string; name: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m3-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  perms = new PermissionService(db);
  sources = new SourceStore(db);
  projects = new ProjectService(db);
  imports = new ImportService(db, vault, perms, sources);
  items = new ItemService(db);
  mcp = new McpService(db);

  project = projects.create({ name: 'M3 项目', rootPath: null, description: null });
  const file = join(dir, 'm3-seed.md');
  writeFileSync(file, '# M3\n\nM3_SEED_MARK 内容。\n', 'utf8');
  const created = imports.importFile(file, {
    projectId: project.id,
    permissionId: perms.grantFile(file).id,
  }).created[0]!;
  const fake = new FakeProvider('m3');
  fake.enqueueStructured({
    items: [
      {
        type: 'decision',
        statement: 'M3 AI 提取的结论',
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S2',
        project_hint: null,
        excerpt: 'M3_SEED_MARK',
      },
    ],
  });
  await new Extractor(db, fake).extractSource(created.id);
  sources.advanceAnalyzedRevision(created.id, 1);
  // 一条用户确认的条目
  const aiItem = db
    .prepare('SELECT id FROM items WHERE extracted_from_source_id = ?')
    .get(created.id) as { id: string };
  items.confirm(aiItem.id);
  // 一次编码 agent 回写（work_result 来源）
  mcp.recordWorkResult({
    project_ref: project.name,
    agent_name: 'codex',
    task: 'M3 前置任务',
    outcome: 'success',
    summary: '完成了前置工作',
    changes: [],
    tests: [],
    open_loops: [],
  });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M3 开工背景', () => {
  it('简报区分 ai / user / work_result 来源', () => {
    const brief = mcp.prepareTask({
      project_ref: project.name,
      task: '测试开工',
      max_chars: 12000,
    });
    const all = [
      ...brief.purpose,
      ...brief.decisions,
      ...brief.rejected_options,
      ...brief.open_loops,
      ...brief.risks,
      ...brief.status,
      ...brief.recent_work,
    ];
    // 用户确认后的 AI 条目：origin 仍是 ai（谁提取的不变），文本带用户已确认标注
    const confirmedEntry = all.find((e) => e.text.includes('M3 AI 提取的结论'))!;
    expect(confirmedEntry.origin).toBe('ai');
    expect(confirmedEntry.text).toContain('用户已确认');
    expect(all.some((e) => e.origin === 'work_result' && e.text.includes('M3 前置任务'))).toBe(
      true,
    ); // agent 自报工作明确标注
  });

  it('覆盖版本：已追平时 hasUnanalyzedContent=false', () => {
    const brief = mcp.prepareTask({
      project_ref: project.name,
      task: '测试',
      max_chars: 12000,
    });
    expect(brief.coverage.hasUnanalyzedContent).toBe(false);
    expect(brief.coverage.maxContentRevision).toBeGreaterThanOrEqual(1);
    expect(brief.coverage.maxAnalyzedRevision).toBeGreaterThanOrEqual(1);
  });

  it('有未分析内容时简报明示「可能落后」', () => {
    // 追加新内容（不分析）→ content > analyzed
    const src = db
      .prepare('SELECT id FROM sources WHERE project_id = ? LIMIT 1')
      .get(project.id) as { id: string };
    sources.appendCapturedTurns(src.id, [
      { order: 10, role: 'user', text: '追加未分析内容 M3_UNANALYZED' },
    ]);
    const brief = mcp.prepareTask({
      project_ref: project.name,
      task: '测试',
      max_chars: 12000,
    });
    expect(brief.coverage.hasUnanalyzedContent).toBe(true);
    expect(brief.coverage.maxContentRevision).toBeGreaterThan(brief.coverage.maxAnalyzedRevision);
    expect(brief.staleness_notice).toContain('可能落后');
  });
});

describe('M3 收工回写幂等', () => {
  const baseInput = {
    project_ref: 'M3 项目',
    agent_name: 'codex',
    task: 'M3 幂等任务',
    outcome: 'success' as const,
    summary: '完成了幂等测试',
    changes: ['a.ts'],
    tests: [{ name: 't1', result: 'passed' as const }],
    open_loops: [],
  };

  it('相同 client_ref 重试返回同一记录（deduplicated=true），不重复入库', () => {
    const first = mcp.recordWorkResult({ ...baseInput, client_ref: 'm3-idem-0001' });
    expect(first.deduplicated).toBe(false);
    const retry = mcp.recordWorkResult({ ...baseInput, client_ref: 'm3-idem-0001' });
    expect(retry.deduplicated).toBe(true);
    expect(retry.work_run_id).toBe(first.work_run_id);
    const count = (
      db.prepare("SELECT COUNT(*) n FROM work_runs WHERE task = 'M3 幂等任务'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it('同键不同内容报冲突', () => {
    mcp.recordWorkResult({ ...baseInput, client_ref: 'm3-idem-0002' });
    expect(() =>
      mcp.recordWorkResult({
        ...baseInput,
        client_ref: 'm3-idem-0002',
        summary: '不同的内容 CONFLICT',
      }),
    ).toThrowError(/client_ref 已被使用|冲突/);
  });

  it('旧客户端不传 client_ref 仍正常（兼容）', () => {
    const result = mcp.recordWorkResult({
      ...baseInput,
      task: 'M3 兼容任务（无 client_ref）',
    });
    expect(result.deduplicated).toBe(false);
    expect(result.work_run_id).toBeTruthy();
  });
});
