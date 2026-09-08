/** Independent review of 65927c6: synthetic data only, no production edits. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Extractor,
  FakeProvider,
  ImportService,
  ItemService,
  McpService,
  PermissionService,
  ProjectService,
  SourceStore,
  Vault,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';

const databases: CoreDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-recheck-round2-'));
  const db = openDatabase(join(dir, 'test.db'));
  databases.push(db);
  migrate(db);
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, new Vault(join(dir, 'vault')), permissions, sources);
  const items = new ItemService(db);
  const project = new ProjectService(db).create({
    name: 'Round2',
    rootPath: null,
    description: null,
  });
  const path = join(dir, 'synthetic.md');
  writeFileSync(path, '# Round2\n\nSYNTHETIC_EVIDENCE\n', 'utf8');
  const permission = permissions.grantFile(path);
  const source = imports.importFile(path, { projectId: project.id, permissionId: permission.id })
    .created[0]!;
  const mcp = new McpService(db);
  const extract = (statements: string[], type: 'constraint' | 'open_loop' = 'constraint') =>
    new Extractor(
      db,
      new FakeProvider().enqueueStructured({
        items: statements.map((statement) => ({
          type,
          statement,
          excerpt: 'SYNTHETIC_EVIDENCE',
          segment_ref: 'S2',
          confidence: 0.95,
          rationale: null,
          project_hint: null,
        })),
      }),
    ).extractSource(source.id);
  return { db, permissions, permission, source, sources, items, project, mcp, extract };
}

for (const entry of ['item', 'source'] as const) {
  it(`R2-01-${entry}: assigning a project must preserve an explicit pending flag on an AI item`, async () => {
    const f = fixture();
    await f.extract(['等待性能测量数据'], 'open_loop');
    const item = f.items.list({ projectId: f.project.id })[0]!;
    expect(item.needs_review).toBe(false);
    f.items.setPendingReview(item.id, true);
    expect(f.items.get(item.id).needs_review).toBe(true);
    if (entry === 'item') f.items.assignToProject(item.id, f.project.id);
    else f.sources.bindProject(f.source.id, f.project.id);
    expect(f.items.get(item.id).needs_review).toBe(true);
  });

  it(`R2-02-${entry}: assigning a project must not resolve a conflict with a protected user constraint`, async () => {
    const f = fixture();
    await f.extract(['日志保留期限为三十天']);
    const original = f.items.list({ projectId: f.project.id })[0]!;
    f.items.correct({ itemId: original.id, userText: '项目日志可以发送到远程服务器保存和分析' });
    await f.extract(['项目日志不可以发送到远程服务器保存和分析']);
    const opposite = f.items
      .list({ projectId: f.project.id })
      .find((i) => i.statement.includes('不可以'))!;
    // Either current+pending or disputed+pending is a valid representation.
    expect(opposite.state).not.toBe('superseded');
    expect(opposite.needs_review).toBe(true);
    if (entry === 'item') f.items.assignToProject(opposite.id, f.project.id);
    else f.sources.bindProject(f.source.id, f.project.id);
    expect(f.items.get(opposite.id).needs_review).toBe(true);
  });
}

it('R2-03: control - repeated ordinary re-extraction preserves all unchanged conclusions', async () => {
  const f = fixture();
  const statements = ['保存红色标记', '开启深夜界面', '输出性能报告'];
  await f.extract(statements.slice(0, 1));
  for (let round = 0; round < 3; round++) {
    await f.extract(statements);
    const current = f.items.list({ projectId: f.project.id, state: 'current' });
    expect(current.map((i) => i.statement).sort()).toEqual([...statements].sort());
  }
});

it('R2-04: control - three corrections protect the last user constraint without reviving predecessors', async () => {
  const f = fixture();
  await f.extract(['日志保留期限为三十天']);
  let current = f.items.list({ projectId: f.project.id })[0]!;
  const oldIds: string[] = [];
  for (const text of [
    '访问令牌只能显示末尾四位',
    '故障日志保存期限为七天',
    '项目日志可以发送到远程服务器保存和分析',
  ]) {
    oldIds.push(current.id);
    current = f.items.correct({ itemId: current.id, userText: text }).newItem;
  }
  await f.extract(['项目日志不可以发送到远程服务器保存和分析']);
  const opposite = f.items
    .list({ projectId: f.project.id })
    .find((i) => i.statement.includes('不可以'))!;
  expect(opposite.needs_review || opposite.state === 'disputed').toBe(true);
  expect(f.items.get(current.id).state).toBe('current');
  for (const id of oldIds) expect(f.items.get(id).state).toBe('superseded');
});

it('R2-05: control - manual/corrected references return actual user text and reject revoked old-source evidence', async () => {
  const f = fixture();
  const manual = f.items.createManual({
    projectId: f.project.id,
    type: 'decision',
    statement: 'SYNTHETIC_MANUAL',
    rationale: null,
  });
  const manualRef = f.mcp.getSourceExcerpt(manual.id, 2000);
  expect(manualRef.excerpt).toContain(manual.statement);
  expect(manualRef.role).toBe('user_manual');
  await f.extract(['SYNTHETIC_OLD']);
  const ai = f.items.list({ projectId: f.project.id }).find((i) => i.origin === 'ai')!;
  const corrected = f.items.correct({ itemId: ai.id, userText: 'SYNTHETIC_CORRECTED' }).newItem;
  const correctedRef = f.mcp.getSourceExcerpt(corrected.id, 2000);
  expect(correctedRef.role).toBe('user_correction');
  expect(correctedRef.excerpt).toContain('SYNTHETIC_CORRECTED');
  expect(correctedRef.excerpt).toContain('SYNTHETIC_OLD');
  f.permissions.revoke(f.permission.id);
  expect(() => f.mcp.getSourceExcerpt(corrected.id, 2000)).toThrow();
  expect(f.mcp.getSourceExcerpt(manual.id, 2000).excerpt).toContain('SYNTHETIC_MANUAL');
});

it('R2-06: control - complete briefing JSON stays within budget with escaped content and long tasks', () => {
  const f = fixture();
  for (let index = 0; index < 5; index++) {
    f.items.createManual({
      projectId: f.project.id,
      type: 'decision',
      statement: `item ${index}: ` + '汉字"\n\\'.repeat(120),
      rationale: null,
    });
  }
  for (const budget of [2000, 2050, 4096, 12000]) {
    for (const task of ['audit', '查询"\n\\'.repeat(1200)]) {
      const brief = f.mcp.prepareTask({ project_ref: f.project.id, task, max_chars: budget });
      expect(JSON.stringify(brief).length).toBeLessThanOrEqual(budget);
      expect(brief.chars_used).toBe(JSON.stringify(brief).length);
    }
  }
});

// --- F01 修复附验（验收条款要求的组合检查） ---

it('F01-a: explicit resolution (setPendingReview false) clears only manual, derived reasons stay honest', async () => {
  const f = fixture();
  await f.extract(['等待性能测量数据'], 'open_loop');
  const item = f.items.list({ projectId: f.project.id })[0]!;
  // 用户显式置位 → manual 原因；显式解除 → manual 消失，无派生原因 → 退出待讨论
  f.items.setPendingReview(item.id, true);
  expect(f.items.get(item.id).needs_review).toBe(true);
  f.items.setPendingReview(item.id, false);
  expect(f.items.get(item.id).needs_review).toBe(false);
  // 重要决定类（unconfirmed 派生原因）：显式解除 manual 后仍待讨论
  // —— 解除动作不能顺带清掉派生原因
  await new Extractor(
    f.db,
    new FakeProvider().enqueueStructured({
      items: [
        {
          type: 'decision',
          statement: '决定：采用方案甲作为打包框架',
          excerpt: 'SYNTHETIC_EVIDENCE',
          segment_ref: 'S2',
          confidence: 0.95,
          rationale: null,
          project_hint: null,
        },
      ],
    }),
  ).extractSource(f.source.id);
  const decision = f.db
    .prepare("SELECT id FROM items WHERE type = 'decision' AND origin = 'ai' AND state = 'current'")
    .get() as { id: string } | undefined;
  expect(decision).toBeDefined();
  f.items.setPendingReview(decision!.id, true);
  f.items.setPendingReview(decision!.id, false);
  expect(f.items.get(decision!.id).needs_review).toBe(true); // unconfirmed 仍在
});

it('F01-b: manual moved item keeps its pending reasons when source is rebound to another project', async () => {
  const f = fixture();
  const other = new ProjectService(f.db).create({
    name: 'Round2Other',
    rootPath: null,
    description: null,
  });
  await f.extract(['等待性能测量数据'], 'open_loop');
  const item = f.items.list({ projectId: f.project.id })[0]!;
  // 用户显式置位 + 人工搬到其他项目
  f.items.setPendingReview(item.id, true);
  f.items.assignToProject(item.id, other.id);
  expect(f.items.get(item.id).needs_review).toBe(true); // manual 仍在（F01 核心）
  expect(f.items.get(item.id).project_id).toBe(other.id);
  // 来源重绑到另一项目：manual_project=1 的条目不被搬动、待处理状态不被改写
  f.sources.bindProject(f.source.id, f.project.id);
  const after = f.items.get(item.id);
  expect(after.project_id).toBe(other.id); // 未被来源级重绑搬走
  expect(after.needs_review).toBe(true); // manual 原因未被顺带清除
});
