import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  AskService,
  FakeProvider,
  ResearchChecker,
  CodingOrchestrator,
  FakeCodingExecutor,
  type CoreDatabase,
  type IndependentCheck,
} from '../../src/index.js';

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;
let items: ItemService;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-b2b4-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  projects = new ProjectService(db);
  items = new ItemService(db);
  projectId = projects.create({ name: '记忆项目', rootPath: null, description: null }).id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('B2 情境记忆：相关才用，无关不提', () => {
  it('无关问题不把个人目标硬塞进模型', async () => {
    items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'goal',
      statement: '做一个本地优先的个人助手',
      rationale: null,
    });
    const provider = new FakeProvider('b2-ask');
    const result = await new AskService(db, provider).ask(null, '今天天气怎么样');
    expect(result.answer).toMatch(/资料不足/);
    expect(provider.textCalls).toHaveLength(0);
  });

  it('问目标时召回用户目标，不要求先选项目', async () => {
    const personal = items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'goal',
      statement: '持续理解我自己',
      rationale: null,
    });
    items.grantDisclosure({ itemId: personal.id, audience: 'model', note: '测试分享给问答' });
    items.createManual({
      projectId,
      type: 'goal',
      statement: '本地桌面记忆系统',
      rationale: null,
    });
    const provider = new FakeProvider('b2-goals');
    provider.enqueueText('你想持续理解自己，并做本地桌面记忆系统 [R1]。');
    const result = await new AskService(db, provider).ask(null, '你目前理解我想做什么？');
    expect(result.answer).toMatch(/理解自己|本地/);
    expect(provider.textCalls[0]!.user).toMatch(/持续理解我自己|本地桌面记忆系统/);
  });

  it('一次性会议要求不升为长期目标，问长期计划时不召回', async () => {
    const ephemeral = items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'goal',
      statement: '这次会议用红色主题，仅本次',
      rationale: null,
    });
    items.grantDisclosure({ itemId: ephemeral.id, audience: 'model', note: '测试' });
    const longTerm = items.createManual({
      projectId: null,
      scope: 'personal',
      type: 'goal',
      statement: '持续理解我自己',
      rationale: null,
    });
    items.grantDisclosure({ itemId: longTerm.id, audience: 'model', note: '测试' });
    const provider = new FakeProvider('b2-ephemeral');
    provider.enqueueText('长期目标是持续理解自己 [R1]。');
    const result = await new AskService(db, provider).ask(null, '你目前理解我想做什么？');
    expect(provider.textCalls[0]!.user).not.toMatch(/这次会议用红色主题/);
    expect(provider.textCalls[0]!.user).toMatch(/持续理解我自己/);
    expect(result.answer).toMatch(/理解自己/);
  });
});

describe('B3 只给方向：无搜索不假装完成', () => {
  it('无来源关注可以创建；立即检查失败且 searchUsed=false', async () => {
    const checker = new ResearchChecker(db);
    const topic = checker.createTopic({
      question: '全能AI工作台有什么值得跟进的新工具',
      sources: [],
    });
    expect(topic.question).toContain('全能AI工作台');
    const result = await checker.checkNow(topic.id);
    expect(result.searchUsed).toBe(false);
    expect(result.run.status).toBe('failed');
    expect(result.run.error ?? '').toMatch(/没有批准来源|不能声称已搜索/);
    expect(checker.store.listFindings(topic.id)).toHaveLength(0);
  });
});

describe('B4 失败进入工作记录，下次问答可读', () => {
  it('执行器失败写入 work_runs，问答能读到失败摘要', async () => {
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
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM work_runs WHERE project_id = ? AND outcome = ?')
      .get(projectId, 'failed') as { n: number };
    expect(n.n).toBeGreaterThan(0);

    const provider = new FakeProvider('b4-ask');
    provider.enqueueText('上次编码任务失败了 [R1]。');
    const answer = await new AskService(db, provider).ask(
      projectId,
      '上次编码任务结果如何？失败了吗？',
    );
    expect(provider.textCalls[0]!.user).toMatch(/工作记录|失败|Produce the approved note/);
    expect(answer.answer).toMatch(/失败/);
  });
});
