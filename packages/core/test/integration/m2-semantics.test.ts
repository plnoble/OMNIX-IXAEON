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
import { M2_SCENARIOS, type M2Scenario } from '@ixaeon/test-fixtures';

/**
 * M2 六类固定语义资料串联验收（《下一阶段开发计划》M2 验收 + v0.2 验收报告
 * 第四节材料缺口第 1 项）：
 * AI 提议未答应 / 明确否决 / 后来改口 / 不同来源矛盾 / 证据不足 /
 * agent 声称完成未验收 —— 每组走「导入 → 提取 → 用户动作 →（次轮）→
 * 断言持久化状态 + MCP 简报输出」。合成资料 + FakeProvider，不需真实 Key。
 */

let dir: string;
let db: CoreDatabase;
let perms: PermissionService;
let sources: SourceStore;
let projects: ProjectService;
let imports: ImportService;
let items: ItemService;
let mcp: McpService;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-m2-sem-'));
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

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 场景项目（幂等：S4 的第二来源复用同一项目）。 */
function scenarioProject(scenario: M2Scenario): { id: string; name: string } {
  const name = `语义-${scenario.id} ${scenario.title}`;
  const existing = projects.list().find((p) => p.name === name);
  if (existing) return existing;
  return projects.create({ name, rootPath: null, description: null });
}

/** 场景独立来源（同项目），写入原文片段。 */
function seedScenarioSource(scenario: M2Scenario, turns: M2Scenario['turns']): string {
  const project = scenarioProject(scenario);
  const file = join(dir, `${scenario.id}-${Math.random().toString(36).slice(2)}.md`);
  const body = turns.map((t) => `${t.role === 'user' ? '用户' : 'AI'}：${t.text}`).join('\n\n');
  writeFileSync(file, `# ${scenario.title}\n\n${body}\n`, 'utf8');
  const created = imports.importFile(file, {
    projectId: project.id,
    permissionId: perms.grantFile(file).id,
  }).created[0]!;
  return created.id;
}

async function runExtraction(
  sourceId: string,
  scenario: M2Scenario,
  which: 'first' | 'second',
): Promise<void> {
  const modelItems = which === 'first' ? scenario.firstExtraction : scenario.secondExtraction;
  if (!modelItems || modelItems.length === 0) return;
  const fake = new FakeProvider(`m2-${scenario.id}-${which}`);
  fake.enqueueStructured({
    items: modelItems.map((m) => ({
      type: m.type,
      statement: m.statement,
      excerpt: m.excerpt,
      segment_ref: m.segment_ref,
      rationale: m.rationale,
      confidence: m.confidence,
      project_hint: null,
    })),
  });
  await new Extractor(db, fake).extractSource(sourceId);
}

/** 用户动作（S6 的 agent 回写由调用侧单独执行）。 */
async function applyUserAction(scenario: M2Scenario, sourceId: string): Promise<void> {
  const action = scenario.userAction;
  if (action.kind === 'none') return;
  const row = db
    .prepare('SELECT id FROM items WHERE extracted_from_source_id = ? LIMIT 1 OFFSET ?')
    .get(sourceId, action.itemIndex) as { id: string } | undefined;
  if (!row) throw new Error(`${scenario.id}: 用户动作目标条目不存在`);
  if (action.kind === 'confirm') items.confirm(row.id);
  else if (action.kind === 'reject') items.reject(row.id);
  else if (action.kind === 'correct') items.correct({ itemId: row.id, userText: action.userText });
}

function assertPersisted(scenario: M2Scenario): void {
  for (const exp of scenario.expectPersisted) {
    const rows = db
      .prepare(`SELECT confirmation, origin, state, needs_review FROM items WHERE statement LIKE ?`)
      .all(`%${exp.statementIncludes}%`) as Array<{
      confirmation: string;
      origin: string;
      state: string;
      needs_review: number;
    }>;
    const match = rows.find(
      (r) =>
        (exp.confirmation === undefined || r.confirmation === exp.confirmation) &&
        (exp.origin === undefined || r.origin === exp.origin) &&
        (exp.state === undefined || r.state === exp.state) &&
        (exp.needsReview === undefined || (r.needs_review === 1) === exp.needsReview),
    );
    expect(
      match,
      `${scenario.id} 持久化断言失败：找不到满足 ${JSON.stringify(exp)} 的条目（候选 ${JSON.stringify(rows)}）`,
    ).toBeDefined();
  }
}

function assertBriefing(scenario: M2Scenario): void {
  const project = scenarioProject(scenario);
  const brief = mcp.prepareTask({ project_ref: project.name, task: '验收', max_chars: 12000 });
  const allEntries = [
    ...brief.purpose,
    ...brief.decisions,
    ...brief.rejected_options,
    ...brief.open_loops,
    ...brief.risks,
    ...brief.status,
    ...brief.recent_work,
  ];
  for (const exp of scenario.expectBriefing) {
    const hit = allEntries.find((e) => e.text.includes(exp.statementIncludes));
    if (exp.present) {
      expect(hit, `${scenario.id} 简报断言失败：应出现「${exp.statementIncludes}」`).toBeDefined();
      if (exp.labelIncludes) {
        expect(
          hit!.text,
          `${scenario.id} 简报标注断言失败：「${exp.statementIncludes}」应带「${exp.labelIncludes}」`,
        ).toContain(exp.labelIncludes);
      }
    } else {
      expect(
        hit,
        `${scenario.id} 简报断言失败：「${exp.statementIncludes}」不应出现在当前理解`,
      ).toBeUndefined();
    }
  }
}

describe('M2 六类固定语义资料串联验收', () => {
  for (const scenario of M2_SCENARIOS) {
    it(`${scenario.id}：${scenario.title}`, async () => {
      // 1) 导入首轮资料 + 提取
      const sourceId = seedScenarioSource(scenario, scenario.turns);
      await runExtraction(sourceId, scenario, 'first');

      // 2) 用户动作
      await applyUserAction(scenario, sourceId);

      // 3) 次轮（S3 改口重提 / S4 第二来源矛盾）
      if (scenario.secondTurns && scenario.secondExtraction) {
        if (scenario.id === 'S4') {
          // 矛盾来自「另一个来源」：新来源、同项目
          const secondSource = seedScenarioSource(scenario, scenario.secondTurns);
          await runExtraction(secondSource, scenario, 'second');
        } else {
          // 同来源追加新内容后重提
          sources.appendCapturedTurns(
            sourceId,
            scenario.secondTurns.map((t) => ({ order: t.order, role: t.role, text: t.text })),
          );
          await runExtraction(sourceId, scenario, 'second');
        }
      }

      // 4) S6：编码 agent 回写「已完成」（未验收）
      if (scenario.id === 'S6') {
        const project = projects
          .list()
          .find((p) => p.name === `语义-${scenario.id} ${scenario.title}`)!;
        mcp.recordWorkResult({
          project_ref: project.name,
          agent_name: 'codex',
          task: '修复登录页 bug',
          outcome: 'success',
          summary: 'agent 自报已完成登录页修复（用户尚未验收）',
          changes: [],
          tests: [],
          open_loops: [],
        });
      }

      // 5) 断言：持久化 + 简报
      assertPersisted(scenario);
      assertBriefing(scenario);
    });
  }

  it('S6 附加：agent 自报工作在简报中标注为 work_result（不等于用户验收）', () => {
    const project = scenarioProject(M2_SCENARIOS.find((s) => s.id === 'S6')!);
    const brief = mcp.prepareTask({ project_ref: project.name, task: '验收', max_chars: 12000 });
    const entry = brief.recent_work.find((e) => e.text.includes('登录页'));
    expect(entry).toBeDefined();
    expect(entry!.origin).toBe('work_result');
    // open_loop 条目仍为 AI 提取（用户自己的待办），与 agent 自报分离
    const loop = [...brief.open_loops, ...brief.risks].find((e) => e.text.includes('修复登录页'));
    expect(loop?.origin ?? 'ai').toBe('ai');
  });
});
