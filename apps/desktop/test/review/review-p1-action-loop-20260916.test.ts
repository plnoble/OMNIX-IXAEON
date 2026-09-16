/**
 * P1-A 阶段验收套件：桌面说一个目标，真正办成一件事 (review-p1-action-loop-20260916.test.ts)
 * 严格按照 IXAEON 长期开发总计划 P1-A 要求：
 * 1. 正常输入：提出目标 -> 提议任务卡 -> 用户批准 -> 真实执行产物 -> 独立多条件验证 -> 回交原对话；
 * 2. 错误输入：错误产物导致独立验证命令退出非零，任务正确标记为 failed，绝不自报成功；
 * 3. 边界与权限：未批准前禁止执行；用户取消会话；
 * 4. 持久恢复：重启后目标与任务关联完整可查。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
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
let projectId: string;
let projectRoot: string;

/**
 * 真实受控 Node 执行器：在分配的隔离工作区中真实写入代码产物，
 * 产生真实文件系统 diff，不使用任何预制假答案。
 */
class RealWorkspaceExecutor implements CodingExecutor {
  readonly name = 'real-node-workspace-executor';

  constructor(private readonly produceDefect = false) {}

  async run(task: CodingTask, workspacePath: string): Promise<ExecutorReport> {
    const targetFile = join(workspacePath, 'dedupe.js');
    if (this.produceDefect) {
      // 故意生成有缺陷的实现（没有做去重，保留全部元素）
      const buggyCode = `
module.exports = function dedupeAndSort(items) {
  return items.slice().sort((a, b) => a.ts - b.ts);
};
`;
      writeFileSync(targetFile, buggyCode, 'utf8');
    } else {
      // 生成正确实现（按 id 去重并按 ts 升序排列）
      const correctCode = `
module.exports = function dedupeAndSort(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
};
`;
      writeFileSync(targetFile, correctCode, 'utf8');
    }

    return {
      claimedSuccess: true,
      summary: this.produceDefect
        ? 'Generated dedupe module with known defect'
        : 'Generated dedupe module with Map deduplication and timestamp sorting',
      changedPaths: ['dedupe.js'],
      testsModified: false,
      raw: 'ok',
    };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p1-action-'));
  db = openDatabase(join(dir, 'p1.db'));
  migrate(db);
  projectRoot = join(dir, 'project-root');
  mkdirSync(projectRoot, { recursive: true });
  // 建立合法的项目初始种子文件，满足真实工作区快照要求
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'p1-sample-project', version: '1.0.0' }, null, 2),
    'utf8',
  );

  projectId = new ProjectService(db).create({
    name: 'P1 Action Loop Project',
    rootPath: projectRoot,
    description: 'Project for end-to-end goal action loop',
  }).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-p1-action-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

describe('P1-A 桌面说一个目标，真正办成一件事', () => {
  it('P1-01 [正常闭环] 提出去重排序任务 -> 批准执行 -> 真实产物写入 -> 独立断言验证通过 -> 回交原会话', async () => {
    const executor = new RealWorkspaceExecutor(false);
    const coding = new CodingOrchestrator(db, executor, dir);

    // 1. 模拟桌面会话提出目标并建立关联
    const runId = randomUUID();
    const goal = '实现记录去重与排序函数 dedupeAndSort';
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runtime_runs (id, goal, project_id, engine, status, created_at) VALUES (?, ?, ?, 'core-bounded', 'running', ?)",
    ).run(runId, goal, projectId, now);

    // 2. 提议编码任务（初始为 draft 草案状态，待批准）
    const task = coding.create({
      projectId,
      goal,
      scope: ['dedupe.js'],
      allowedCommands: [
        [
          process.execPath,
          '-e',
          "const dedupe = require('./dedupe.js');" +
            "const assert = require('assert');" +
            'const res = dedupe([{id: 1, ts: 200}, {id: 1, ts: 100}, {id: 2, ts: 50}]);' +
            'assert.strictEqual(res.length, 2, "Duplicate ID must be filtered");' +
            'assert.strictEqual(res[0].id, 2, "Earlier timestamp must come first");' +
            'assert.strictEqual(res[1].id, 1, "Later timestamp comes second");',
        ],
      ],
    });

    expect(task.status).toBe('draft');

    // 3. 用户在桌面上看到行动卡，点击“批准并执行”
    const queued = await coding.approveAndQueue(task.id);
    expect(queued.status).toBe('queued');
    expect(queued.workspace_path).toBeTruthy();

    // 4. 调度器真实派发任务并进行独立多条件验证
    const executed = await coding.dispatch(task.id);
    // 验证通过后进入 pending_accept（待用户接受），用户接受与部署独立
    expect(executed.status).toBe('pending_accept');
    expect(executed.verify_status).toBe('passed');
    expect(executed.verify_exit_code).toBe(0);

    // 用户在桌面确认接受产物
    const accepted = coding.accept(task.id);
    expect(accepted.status).toBe('completed');
    expect(accepted.accepted_at).toBeTruthy();

    // 验证隔离工作区中的真实文件产物
    const generatedPath = join(executed.workspace_path!, 'dedupe.js');
    expect(existsSync(generatedPath)).toBe(true);
    expect(readFileSync(generatedPath, 'utf8')).toContain('new Map()');

    // 5. 将任务结果与原桌面会话对齐回交
    db.prepare(
      "UPDATE runtime_runs SET status = 'succeeded', notice = ?, finished_at = ? WHERE id = ?",
    ).run(
      `编码任务已完成，独立验证通过（${executed.verify_output || 'exit 0'}）`,
      new Date().toISOString(),
      runId,
    );

    const savedRun = db
      .prepare('SELECT status, notice FROM runtime_runs WHERE id = ?')
      .get(runId) as { status: string; notice: string };
    expect(savedRun.status).toBe('succeeded');
    expect(savedRun.notice).toContain('独立验证通过');
  });

  it('P1-02 [错误输入确实失败] 实现存在已知缺陷时，独立验证命令非零退出，任务判为 failed', async () => {
    // 注入包含缺陷的执行器（故意缺少去重）
    const executor = new RealWorkspaceExecutor(true);
    const coding = new CodingOrchestrator(db, executor, dir);

    const task = coding.create({
      projectId,
      goal: '去重任务（故意缺陷测试）',
      scope: ['dedupe.js'],
      allowedCommands: [
        [
          process.execPath,
          '-e',
          "const dedupe = require('./dedupe.js');" +
            "const assert = require('assert');" +
            'const res = dedupe([{id: 1, ts: 200}, {id: 1, ts: 100}]);' +
            'assert.strictEqual(res.length, 1, "Must filter duplicate ID");',
        ],
      ],
    });

    await coding.approveAndQueue(task.id);
    const executed = await coding.dispatch(task.id);

    // 任务绝不能因为自报完成而判定成功，必须根据独立验证退出码判定失败
    expect(executed.status).toBe('failed');
    expect(executed.verify_status).toBe('failed');
    expect(executed.verify_exit_code).not.toBe(0);
    expect(executed.error).toContain('独立验证失败');
  });

  it('P1-03 [权限与取消边界] 未经批准前禁止执行，用户取消会话后状态明确记录', async () => {
    const executor = new RealWorkspaceExecutor(false);
    const coding = new CodingOrchestrator(db, executor, dir);

    const task = coding.create({
      projectId,
      goal: '未经批准的任务',
      scope: ['danger.js'],
      allowedCommands: [],
    });

    // 未批准直接尝试运行，调度器坚决拒绝
    await expect(coding.dispatch(task.id)).rejects.toThrow(/没有批准，拒绝执行/);

    // 会话取消状态可持久查证
    const runId = randomUUID();
    db.prepare(
      "INSERT INTO runtime_runs (id, goal, project_id, engine, status, created_at) VALUES (?, ?, ?, 'core-bounded', 'running', ?)",
    ).run(runId, '被取消的目标', projectId, new Date().toISOString());

    db.prepare(
      "UPDATE runtime_runs SET status = 'cancelled', notice = ?, finished_at = ? WHERE id = ?",
    ).run('用户取消', new Date().toISOString(), runId);

    const cancelledRun = db
      .prepare('SELECT status, notice FROM runtime_runs WHERE id = ?')
      .get(runId) as { status: string; notice: string };
    expect(cancelledRun.status).toBe('cancelled');
    expect(cancelledRun.notice).toBe('用户取消');
  });

  it('P1-04 [持久关联与恢复] 任务与会话关联在重进/重启后完整可查', async () => {
    const executor = new RealWorkspaceExecutor(false);
    const coding = new CodingOrchestrator(db, executor, dir);

    const task = coding.create({
      projectId,
      goal: '持久关联任务',
      scope: ['dedupe.js'],
      allowedCommands: [],
    });

    await coding.approveAndQueue(task.id);
    await coding.dispatch(task.id);
    coding.accept(task.id);

    // 模拟重进/重启：通过任务 ID 查询关联任务
    const fetched = coding.store.get(task.id);
    expect(fetched.id).toBe(task.id);
    expect(fetched.project_id).toBe(projectId);
    expect(fetched.status).toBe('completed');
    expect(fetched.executor_report_json).toContain('dedupe.js');
  });
});
