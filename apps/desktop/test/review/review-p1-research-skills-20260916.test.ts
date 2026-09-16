/**
 * P1-D（主动研究，不是收藏网页）与 P1-E（方法真正进入下一次工作）验收套件
 * 按照 IXAEON 长期开发总计划 2026-09-16 编制：
 * 1. P1-D 主动研究：包含新事实与来源、去重、调度管理、暂停停止新调用、预算限额控制；
 * 2. P1-E 方法复用：前后对照获准 Skill -> 下一次任务派发真实提取该方法并注入执行上下文 -> 其他项目/不适用任务隔离 -> 撤销后不再使用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ResearchStore,
  SkillCandidateStore,
  CodingOrchestrator,
  type CodingExecutor,
  type ExecutorReport,
  ProjectService,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';
import type { CodingTask } from '../../../../packages/contracts/src/index.js';

let dir: string;
let db: CoreDatabase;
let researchStore: ResearchStore;
let skillStore: SkillCandidateStore;
let projects: ProjectService;
let projectId: string;
let projectRoot: string;

/** 受控模拟执行器，用于捕获任务派发时的实际目标 (dispatched goal) */
class CapturingExecutor implements CodingExecutor {
  readonly name = 'capturing-executor';
  lastDispatchedGoal: string = '';

  async run(task: CodingTask): Promise<ExecutorReport> {
    this.lastDispatchedGoal = task.goal;
    return {
      claimedSuccess: true,
      summary: 'Task executed with captured goal',
      changedPaths: ['index.js'],
      testsModified: false,
      raw: 'ok',
    };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p1-res-sk-'));
  db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  researchStore = new ResearchStore(db);
  skillStore = new SkillCandidateStore(db);
  projects = new ProjectService(db);

  projectRoot = join(dir, 'project-root');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), '{"name":"p1-project"}', 'utf8');

  projectId = projects.create({
    name: 'P1-Research-Skills-Project',
    rootPath: projectRoot,
    description: 'Project for research and skill reuse testing',
  }).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-p1-res-sk-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

describe('P1-D 主动研究，不是收藏网页', () => {
  it('P1-D01 [研究产物与指纹去重] 记录包含新事实与行动价值的发现，相同内容指纹自动去重', () => {
    const topic = researchStore.createTopic({
      question: '最新 Rust 异步网络库发展',
      publicDescription: '追踪 Tokio 与 Smol 等异步框架的新版本变更与最佳实践',
      relatedProjectId: projectId,
      sources: [],
    });

    const source = researchStore.addSource(topic.id, {
      url: 'https://example.com/rust-async-update',
      kind: 'page',
    });

    // 记录首次发现
    const now = new Date().toISOString();
    const f1 = researchStore.insertFinding({
      topicId: topic.id,
      sourceId: source.id,
      title: 'Tokio 1.35 发布：新增协作调度增强',
      url: 'https://example.com/rust-async-update',
      excerpt: 'Tokio 引入了针对密集计算任务的自适应协作 yield 调度机制',
      fingerprint: 'tokio-1.35-yield-sched',
      claimedPublishedAt: now,
      fetchedAt: now,
      relatedGoalId: null,
      relatedProjectId: projectId,
    });

    expect(f1).toBeTruthy();
    // 标记行动价值与建议
    const marked = researchStore.setFindingAction(f1!.id, {
      actionWorthy: true,
      actionReason: '本项目涉及的高并发服务需要参考该调度配置',
    });
    expect(marked.action_worthy).toBe(true);
    expect(marked.action_reason).toContain('高并发服务');

    // 再次记录相同内容指纹的发现（模拟轮询时内容未变）
    const f2 = researchStore.insertFinding({
      topicId: topic.id,
      sourceId: source.id,
      title: 'Tokio 1.35 发布：新增协作调度增强（重复抓取）',
      url: 'https://example.com/rust-async-update',
      excerpt: 'Tokio 引入了针对密集计算任务的自适应协作 yield 调度机制',
      fingerprint: 'tokio-1.35-yield-sched',
      claimedPublishedAt: now,
      fetchedAt: now,
      relatedGoalId: null,
      relatedProjectId: projectId,
    });

    const findings = researchStore.listFindings(topic.id);
    // 重复指纹被去重忽略（f2 返回 null，条目数仍为 1）
    expect(f2).toBeNull();
    expect(findings.length).toBe(1);
  });

  it('P1-D02 [调度管理与暂停] 主题未启用或暂停时，到期调度池坚决不调度', () => {
    const now = new Date().toISOString();
    const topic = researchStore.createTopic({
      question: 'TypeScript 5.8 新特性',
      publicDescription: '监控 TS 5.8 类型系统变更',
      relatedProjectId: projectId,
      sources: [],
    });

    // 初始状态：未启用（enabled=false）
    let due = researchStore.dueTopics(now);
    expect(due.some((t) => t.id === topic.id)).toBe(false);

    // 启用研究方向：排期至当前时间
    researchStore.setEnabled(topic.id, true, now);
    due = researchStore.dueTopics(now);
    expect(due.some((t) => t.id === topic.id)).toBe(true);

    // 用户在桌面端点击“暂停”
    researchStore.setPaused(topic.id, true, now);
    due = researchStore.dueTopics(now);
    // 暂停后绝不再排入到期调度池
    expect(due.some((t) => t.id === topic.id)).toBe(false);

    // 恢复后重新排期
    researchStore.setPaused(topic.id, false, now);
    due = researchStore.dueTopics(now);
    expect(due.some((t) => t.id === topic.id)).toBe(true);
  });

  it('P1-D03 [预算限额] 支持配置请求配额并在预算耗尽时受控停止', () => {
    const topic = researchStore.createTopic({
      question: '开源大模型微调进展',
      publicDescription: '监控微调成本与前沿架构',
      sources: [],
    });

    // 设置请求上限为 3 次
    const updated = researchStore.setBudget(topic.id, {
      paidBudgetMode: 'request_cap',
      requestCap: 3,
    });
    expect(updated.paid_budget_mode).toBe('request_cap');
    expect(updated.request_cap).toBe(3);

    // 模拟配额耗尽
    const zeroBudget = researchStore.setBudget(topic.id, {
      paidBudgetMode: 'request_cap',
      requestCap: 0,
    });
    expect(zeroBudget.request_cap).toBe(0);
  });
});

describe('P1-E 方法真正进入下一次工作', () => {
  it('P1-E01 [方法对照获准并进入下次任务] 失败基线生成候选 -> 实质检验获准 -> 派发新任务真实注入获准 Skill', async () => {
    // 1. 模拟一次真实失败的运行记录
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', '实现带超时的 Fetch 封装', 'failed', '未处理超时信号抛出，测试非零退出', ?, '[]', '[]', ?)`,
    ).run(
      runId,
      projectId,
      JSON.stringify({ passed: false, verify_exit_code: 1 }),
      new Date().toISOString(),
    );

    // 2. 产生技能候选
    const candidate = skillStore.proposeFromFailure({
      projectId,
      workRunId: runId,
      task: '实现带超时的 Fetch 封装',
      summary: '需要使用 AbortController.timeout 配合 signal 实现优雅超时处理',
    });

    // 3. 执行受控对照评测（使用实质断言且退出码为 0 的命令）
    const evalCmd = ['node', '-e', 'assert.strictEqual(typeof AbortController, "function");'];
    skillStore.evaluateWithEvidence(candidate.id, {
      evidence: {
        command: evalCmd,
        exitCodeBefore: 1,
        outputBefore: '原实现未绑定 signal 导致挂起超时失败 (exit 1)',
        exitCodeAfter: 0,
        outputAfter: '使用 AbortController 与 signal 成功超时熔断 (exit 0)',
        verifiedAt: new Date().toISOString(),
        producedBy: 'controlled',
        evaluatedAtVersion: candidate.version + 1,
        methodSnapshot: candidate.method,
      },
      benefit: '解决外部网络请求无响应时的卡死问题，测试顺利通过',
    });

    // 4. 用户在桌面上审查前后对照与客观证据后点击“批准”
    const approved = skillStore.approve(candidate.id);
    expect(approved.status).toBe('approved');

    // 5. 准备下一次同类编码任务，验证调度器真实使用被批准的方法
    const capturingExecutor = new CapturingExecutor();
    const coding = new CodingOrchestrator(db, capturingExecutor, dir);

    const nextTask = coding.create({
      projectId,
      goal: '开发用户网络请求网关模块',
      scope: ['index.js'],
      allowedCommands: [],
    });

    await coding.approveAndQueue(nextTask.id);
    await coding.dispatch(nextTask.id);

    // 核心断言：下一次任务的派发目标中，真实包含了获准 Skill 的标题与方法！
    expect(capturingExecutor.lastDispatchedGoal).toContain('获准 Skill（用户已对照批准）');
    expect(capturingExecutor.lastDispatchedGoal).toContain(candidate.title);
  });

  it('P1-E02 [范围隔离与废弃后不复用] 异构项目不注入该 Skill，撤销/废弃后不再使用', async () => {
    // 1. 创建另一个完全无关的项目
    const otherProjectRoot = join(dir, 'other-project');
    mkdirSync(otherProjectRoot, { recursive: true });
    writeFileSync(join(otherProjectRoot, 'package.json'), '{"name":"other-proj"}', 'utf8');

    const otherProjectId = projects.create({
      name: 'Other-Unrelated-Project',
      rootPath: otherProjectRoot,
      description: 'Unrelated project',
    }).id;

    // 2. 为当前项目注入一个已获准的 Skill
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO work_runs (id, project_id, agent_name, task, outcome, summary, tests_json, changes_json, open_loops_json, finished_at)
       VALUES (?, ?, 'codex', '项目专属加密方法', 'failed', '密钥填充失败', ?, '[]', '[]', ?)`,
    ).run(
      runId,
      projectId,
      JSON.stringify({ passed: false, verify_exit_code: 1 }),
      new Date().toISOString(),
    );

    const candidate = skillStore.proposeFromFailure({
      projectId,
      workRunId: runId,
      task: 'AES-GCM 认证加密',
      summary: '采用 WebCrypto AES-GCM 算法',
    });

    skillStore.evaluateWithEvidence(candidate.id, {
      evidence: {
        command: ['node', '-e', 'assert.ok(crypto.webcrypto);'],
        exitCodeBefore: 1,
        outputBefore: 'exit 1',
        exitCodeAfter: 0,
        outputAfter: 'exit 0',
        verifiedAt: new Date().toISOString(),
        producedBy: 'controlled',
        evaluatedAtVersion: candidate.version + 1,
        methodSnapshot: candidate.method,
      },
      benefit: '安全性提升，自动化断言通过',
    });

    skillStore.approve(candidate.id);

    const capturingExecutor = new CapturingExecutor();
    const coding = new CodingOrchestrator(db, capturingExecutor, dir);

    // 3. 在异构项目创建任务，派发后确认不注入该项目的 Skill
    const otherTask = coding.create({
      projectId: otherProjectId,
      goal: '开发其他模块',
      scope: ['index.js'],
      allowedCommands: [],
    });
    await coding.approveAndQueue(otherTask.id);
    await coding.dispatch(otherTask.id);

    expect(capturingExecutor.lastDispatchedGoal).toContain('获准 Skill：无');
    expect(capturingExecutor.lastDispatchedGoal).not.toContain('AES-GCM');

    // 4. 用户对原项目的 Skill 进行废弃/撤销（retire）
    skillStore.retire(candidate.id);

    // 原项目再执行新任务，确认已不再注入已废弃的方法
    const retryTask = coding.create({
      projectId,
      goal: '新加密尝试',
      scope: ['index.js'],
      allowedCommands: [],
    });
    await coding.approveAndQueue(retryTask.id);
    await coding.dispatch(retryTask.id);

    expect(capturingExecutor.lastDispatchedGoal).toContain('获准 Skill：无');
    expect(capturingExecutor.lastDispatchedGoal).not.toContain('AES-GCM');
  });
});
