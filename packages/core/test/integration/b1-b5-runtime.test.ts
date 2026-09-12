import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCodes } from '@ixaeon/contracts';
import {
  openDatabase,
  migrate,
  currentMigrationVersion,
  ProjectService,
  ItemService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
  FakeProvider,
  HermesRuntimeAdapter,
  CoreToolBroker,
  AgentSession,
  SkillCandidateStore,
  type CoreDatabase,
  type IndependentCheck,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;
let items: ItemService;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-b1b5-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  projects = new ProjectService(db);
  items = new ItemService(db);
  projectId = projects.create({ name: '运行时项目', rootPath: null, description: null }).id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function broker(): CoreToolBroker {
  return new CoreToolBroker(
    db,
    items,
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    projects,
  );
}

describe('B1 桌面产品路径：先探 Hermes，缺引擎走 Core 循环', () => {
  it('未装 Hermes 时仍可用工具循环回答，并记下 runtime_runs', async () => {
    delete process.env.IXAEON_HERMES_EXE;
    const goal = items.createManual({
      projectId,
      type: 'goal',
      statement: '把桌面对话接到有界工具循环',
      rationale: null,
    });
    const provider = new FakeProvider('core-bounded');
    provider.enqueueStructured({ tool: 'search_memory', args: { query: '桌面对话' } });
    provider.enqueueStructured({
      tool: 'get_evidence',
      args: { itemId: goal.id },
    });
    provider.enqueueStructured({
      tool: 'answer',
      args: { text: '你想把桌面对话接到有界工具循环。这不是 Hermes。' },
    });
    const session = new AgentSession(db, new HermesRuntimeAdapter(), broker(), provider);
    const result = await session.run({ goal: '你目前理解我想做什么？', projectId });
    expect(result.engine).toBe('core-bounded');
    expect(result.notice ?? '').toMatch(/不是 Hermes|未安装/);
    expect(result.answer).toMatch(/有界工具循环/);
    expect(result.steps.some((s) => s.tool === 'search_memory' && s.ok)).toBe(true);
    expect(result.steps.some((s) => s.tool === 'answer')).toBe(true);
    const run = db
      .prepare('SELECT engine, status FROM runtime_runs WHERE id = ?')
      .get(result.runId) as {
      engine: string;
      status: string;
    };
    expect(run.engine).toBe('core-bounded');
    expect(run.status).toBe('succeeded');
  });

  it('search_web 与 dispatch_coding_task 如实失败，不编造成功', async () => {
    const provider = new FakeProvider('denied');
    provider.enqueueStructured({ tool: 'search_web', args: { query: '全能AI工作台' } });
    provider.enqueueStructured({
      tool: 'dispatch_coding_task',
      args: { taskId: 'x', approved: true },
    });
    provider.enqueueStructured({
      tool: 'answer',
      args: { text: '搜索未配置；编码必须由你在桌面批准，模型参数不算授权。' },
    });
    const session = new AgentSession(db, new HermesRuntimeAdapter(), broker(), provider);
    const result = await session.run({ goal: '请搜索并直接改代码', projectId });
    expect(result.steps.find((s) => s.tool === 'search_web')?.ok).toBe(false);
    expect(result.steps.find((s) => s.tool === 'dispatch_coding_task')?.ok).toBe(false);
    expect(result.steps.find((s) => s.tool === 'search_web')?.detail).toMatch(/搜索入口未配置/);
    expect(result.steps.find((s) => s.tool === 'dispatch_coding_task')?.detail).toMatch(
      /桌面用户批准/,
    );
    expect(result.answer).toMatch(/搜索未配置|必须由你/);
  });

  it('模型未配置时不能假装 Agent 已接通', async () => {
    const session = new AgentSession(db, new HermesRuntimeAdapter(), broker(), null);
    await expect(session.run({ goal: '你好', projectId: null })).rejects.toMatchObject({
      code: ErrorCodes.MODEL_NOT_CONFIGURED,
    });
  });

  it('取消后不再把晚到动作当完成', async () => {
    const provider = new FakeProvider('cancel');
    provider.enqueueStructured({ tool: 'search_memory', args: { query: '取消' } });
    provider.enqueueStructured({ tool: 'answer', args: { text: '不该出现' } });
    const session = new AgentSession(db, new HermesRuntimeAdapter(), broker(), provider);
    const runId = crypto.randomUUID();
    provider.beforeStructured = () => {
      if (provider.structuredCalls.length >= 1) session.cancel(runId);
    };
    const result = await session.run({ goal: '取消这次', projectId, runId });
    expect(result.notice).toBe('用户取消');
    expect(result.answer).toMatch(/已取消/);
    expect(result.steps.some((s) => s.tool === 'answer')).toBe(false);
    const row = db.prepare('SELECT status FROM runtime_runs WHERE id = ?').get(runId) as {
      status: string;
    };
    expect(row.status).toBe('cancelled');
  });
});

describe('B4 Skill 候选：提案≠升级', () => {
  it('失败任务自动提案；无对照不能批准；无收益保持未采用；批准后进入派发背景', async () => {
    const passingCheck = async (argv: string[]): Promise<IndependentCheck> => ({
      argv,
      exitCode: 0,
      output: 'ok',
      ran: true,
    });
    const orch = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({ claimedSuccess: false, files: {} }),
      dir,
      passingCheck,
    );
    const task = orch.create({
      projectId,
      goal: 'Produce the approved note',
      scope: ['note.txt'],
      allowedCommands: [['check']],
    });
    await orch.approveAndQueue(task.id);
    const failed = await orch.dispatch(task.id);
    expect(failed.status).toBe('failed');

    const skills = new SkillCandidateStore(db);
    const proposed = skills.list(projectId);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.status).toBe('proposed');
    expect(() => skills.approve(proposed[0]!.id)).toThrow(/对照评测/);

    skills.evaluate(proposed[0]!.id, {
      evalBefore: '缺 note.txt 即失败',
      evalAfter: '缺 note.txt 即失败',
      benefit: '无收益',
    });
    expect(() => skills.approve(proposed[0]!.id)).toThrow(/未采用/);

    const useful = skills.proposeFromFailure({
      projectId,
      task: '写 note 前先检查路径',
      summary: '上次因缺文件失败',
    });
    skills.evaluate(useful.id, {
      evalBefore: '缺文件即失败且无提示',
      evalAfter: '缺文件时明确列出缺失路径',
      benefit: '同类任务能提前发现缺文件',
    });
    expect(skills.approve(useful.id).status).toBe('approved');

    const spy = new FakeCodingExecutor({ claimedSuccess: false, files: {} });
    const orch2 = new CodingOrchestrator(db, spy, dir, passingCheck);
    const next = orch2.create({
      projectId,
      goal: '再写一次 note',
      scope: ['note.txt'],
      allowedCommands: [['check']],
    });
    await orch2.approveAndQueue(next.id);
    await orch2.dispatch(next.id);
    expect(spy.lastGoal).toMatch(/获准 Skill/);
    expect(spy.lastGoal).toMatch(/写 note 前先检查路径/);
  });
});

describe('B5 合成旧库升级到 18', () => {
  it('迁移 17 副本升级到 18 且幂等，新表存在，旧归档列仍在', () => {
    const oldDir = mkdtempSync(join(tmpdir(), 'ixaeon-m17-'));
    const oldDbPath = join(oldDir, 'old.db');
    const old = openDatabase(oldDbPath);
    migrate(old, 17);
    expect(currentMigrationVersion(old)).toBe(17);
    const tables17 = (
      old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables17).toContain('sources');
    expect(tables17).not.toContain('runtime_runs');
    old.close();

    const upgraded = openDatabase(oldDbPath);
    migrate(upgraded);
    expect(currentMigrationVersion(upgraded)).toBe(18);
    migrate(upgraded);
    expect(currentMigrationVersion(upgraded)).toBe(18);
    const cols = (
      upgraded.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('archived_at');
    expect(cols).toContain('archive_summary');
    const tables = (
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('runtime_runs');
    expect(tables).toContain('skill_candidates');
    upgraded.close();
    rmSync(oldDir, { recursive: true, force: true });
  });
});
