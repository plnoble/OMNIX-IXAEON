import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { fixturePath } from '@ixaeon/test-fixtures';

let dir: string;
let db: CoreDatabase;
let mcp: McpService;
let items: ItemService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m3-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const vault = new Vault(join(dir, 'vault'));
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const projects = new ProjectService(db);
  const imports = new ImportService(db, vault, permissions, sources);
  items = new ItemService(db);
  mcp = new McpService(db);

  // 项目 + 导入 + 提取（FakeProvider 造有依据的条目）
  project = projects.create({
    name: 'OMNIX 主线',
    rootPath: 'D:\\code\\omnix',
    description: null,
  });
  const doc = fixturePath('files', 'project-notes.md');
  const result = imports.importFile(doc, { projectId: project.id, permissionId: permissions.grantFile(doc).id });
  const fake = new FakeProvider('fake-m3');
  fake.enqueueStructured({
    items: [
      {
        type: 'project_summary',
        statement: 'IXAEON 是本地优先的项目记忆系统',
        rationale: '文档首行',
        confidence: 0.95,
        segment_ref: 'S2',
        project_hint: null,
        excerpt: '这是 IXAEON 的脱敏测试文档',
      },
      {
        type: 'decision',
        statement: '第一版只做 Windows 桌面端',
        rationale: null,
        confidence: 0.9,
        segment_ref: 'S6',
        project_hint: null,
        excerpt: '数据存储在本机',
      },
      {
        type: 'rejected_option',
        statement: '否决了 Notion 后端方案',
        rationale: null,
        confidence: 0.85,
        segment_ref: 'S8',
        project_hint: null,
        excerpt: '使用 Notion 作为后端：已否决',
      },
    ],
  });
  const extractor = new Extractor(db, fake);
  void extractor.extractSource(result.created[0]!.id);
});

let project: { id: string; name: string; root_path: string | null };

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M3 prepare_task（计划 6.1）', () => {
  it('项目三种引用方式都能解析（名称 / ID / 根路径）', () => {
    const byName = mcp.prepareTask({ project_ref: 'OMNIX 主线', task: '测试', max_chars: 12000 });
    expect(byName.project_name).toBe('OMNIX 主线');
    const byId = mcp.prepareTask({ project_ref: project.id, task: '测试', max_chars: 12000 });
    expect(byId.project_id).toBe(project.id);
    const byPath = mcp.prepareTask({
      project_ref: project.root_path!,
      task: '测试',
      max_chars: 12000,
    });
    expect(byPath.project_id).toBe(project.id);
  });

  it('简报包含目的/决定/否决 + 每条带引用 ID + 时间戳与过期提醒', () => {
    const out = mcp.prepareTask({ project_ref: 'OMNIX 主线', task: '加登录页', max_chars: 12000 });
    expect(out.purpose.length).toBeGreaterThanOrEqual(1);
    expect(out.decisions.some((d) => d.text.includes('Windows'))).toBe(true);
    expect(out.rejected_options.some((r) => r.text.includes('Notion'))).toBe(true);
    // 引用 ID 是真实 item id
    const firstRef = out.decisions[0]!.ref;
    expect(items.get(firstRef).id).toBe(firstRef);
    expect(out.generated_at).toBeTruthy();
    expect(out.staleness_notice).toContain('可能已有新决定');
    expect(out.chars_used).toBeLessThanOrEqual(out.char_budget);
  });

  it('字符预算生效：2000 上限时截断并标记', () => {
    const out = mcp.prepareTask({ project_ref: 'OMNIX 主线', task: '测试', max_chars: 2000 });
    expect(out.char_budget).toBe(2000);
    expect(out.chars_used).toBeLessThanOrEqual(2000);
    if (out.truncated) {
      expect(out.staleness_notice).toContain('截断');
    }
  });

  it('不存在的项目报 NOT_FOUND', () => {
    expect(() =>
      mcp.prepareTask({ project_ref: '不存在的项目', task: 'x', max_chars: 12000 }),
    ).toThrowError(/未找到项目/);
  });
});

describe('M3 search_context + get_source_excerpt（计划 6.2 / 6.3）', () => {
  it('检索条目命中（含引用、类型、状态）', () => {
    const out = mcp.searchContext({ query: 'Windows', limit: 8 });
    expect(out.results.length).toBeGreaterThanOrEqual(1);
    const hit = out.results.find((r) => r.kind === 'item')!;
    expect(hit.excerpt).toContain('Windows');
    expect(hit.state).toBe('current');
    expect(hit.type).toBe('decision');
  });

  it('get_source_excerpt 按 item 引用返回原文 + 上下文', () => {
    const search = mcp.searchContext({ query: 'Windows', limit: 8 });
    const itemHit = search.results.find((r) => r.kind === 'item')!;
    const excerpt = mcp.getSourceExcerpt(itemHit.ref, 2000);
    expect(excerpt.ref).toBe(itemHit.ref);
    expect(excerpt.excerpt.length).toBeGreaterThan(0);
    expect(excerpt.source_title).toContain('project-notes');
  });

  it('无效引用报 INVALID_REFERENCE，不猜测', () => {
    expect(() => mcp.getSourceExcerpt('not-a-real-id', 2000)).toThrowError(/引用不存在/);
  });

  it('无 project_ref 时跨项目检索', () => {
    const out = mcp.searchContext({ query: 'IXAEON', limit: 20 });
    expect(out.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('M3 record_work_result（计划 6.4 / 4.8）', () => {
  it('写回工作记录 + open_loop 只进待讨论（不自动成为用户决定）', () => {
    const out = mcp.recordWorkResult({
      project_ref: 'OMNIX 主线',
      agent_name: 'codex',
      task: '实现登录页',
      outcome: 'partial',
      summary: '完成了 UI，但还有验证逻辑未写',
      changes: ['apps/desktop/src/renderer/src/pages/Login.tsx'],
      tests: [
        { name: 'login renders', result: 'passed' },
        { name: 'validation logic', result: 'failed' },
      ],
      open_loops: ['登录表单的服务端验证'],
      commit_ref: 'abc123',
    });

    expect(out.work_run_id).toBeTruthy();
    expect(out.open_loop_candidates.length).toBe(1);

    // 工作记录存在
    const run = db
      .prepare('SELECT agent_name, outcome, commit_ref FROM work_runs WHERE id = ?')
      .get(out.work_run_id) as { agent_name: string; outcome: string; commit_ref: string | null };
    expect(run.agent_name).toBe('codex');
    expect(run.outcome).toBe('partial');
    expect(run.commit_ref).toBe('abc123');

    // open_loop 候选：origin=work_result + needs_review（待讨论），不是用户决定
    const candidate = items.get(out.open_loop_candidates[0]!.item_id);
    expect(candidate.origin).toBe('work_result');
    expect(candidate.needs_review).toBe(true);
    expect(candidate.state).toBe('current');
  });

  it('prepare_task 的 recent_work 包含刚写回的工作', () => {
    const out = mcp.prepareTask({ project_ref: 'OMNIX 主线', task: '继续', max_chars: 30000 });
    expect(out.recent_work.length).toBeGreaterThanOrEqual(1);
    expect(out.recent_work.some((w) => w.text.includes('codex'))).toBe(true);
    expect(out.recent_work.some((w) => w.text.includes('登录页'))).toBe(true);
  });
});
