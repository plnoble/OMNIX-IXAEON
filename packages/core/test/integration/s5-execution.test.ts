import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  currentMigrationVersion,
  ProjectService,
  CodingTaskStore,
  CodingOrchestrator,
  FakeCodingExecutor,
  ResearchStore,
  type CoreDatabase,
  type IndependentCheck,
} from '../../src/index.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

let dir: string;
let db: CoreDatabase;
let projects: ProjectService;
let projectId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-s5-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  projects = new ProjectService(db);
  projectId = projects.create({ name: '执行项目', rootPath: null, description: null }).id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('A18 批准绑定', () => {
  it('全新库迁移版本为 15', () => {
    expect(currentMigrationVersion(db)).toBeGreaterThanOrEqual(15);
  });

  it('无批准、过期、修改后旧批准、错误项目、越界路径均拒绝', () => {
    const store = new CodingTaskStore(db);
    const task = store.create({
      projectId,
      goal: '加一个说明文件',
      scope: ['note.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    expect(() => store.liveApproval(task)).toThrow(/没有批准/);

    store.prepareWorkspace(task.id, dir);
    const expired = store.approve({
      taskId: task.id,
      workspacePath: store.get(task.id).workspace_path!,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(() => store.liveApproval(store.get(task.id))).toThrow(/过期/);
    void expired;

    const t2 = store.create({
      projectId,
      goal: '第二任务',
      scope: ['a.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    const prepared = store.prepareWorkspace(t2.id, dir);
    store.approve({ taskId: t2.id, workspacePath: prepared.workspace_path! });
    store.bumpVersion(t2.id, { goal: '已改目标' });
    expect(() => store.liveApproval(store.get(t2.id))).toThrow(/任务已修改|旧批准/);

    const other = projects.create({ name: '别的项目', rootPath: null, description: null });
    expect(() =>
      store.create({
        projectId: '00000000-0000-0000-0000-000000000000',
        goal: 'x',
        scope: ['a.txt'],
        allowedCommands: [],
      }),
    ).toThrow();
    void other;

    expect(() =>
      store.create({
        projectId,
        goal: '越界',
        scope: ['..\\secret.txt'],
        allowedCommands: [['node', '-e', 'process.exit(0)']],
      }),
    ).toThrow(/越界|PATH|非法/);
  });
});

describe('A19 执行隔离', () => {
  it('Fake 适配器不拼 shell；越界产物拒绝；未批准命令拒绝', async () => {
    const orch = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({ files: { 'note.txt': 'ok' } }),
      dir,
      async () => ({
        argv: ['node', '-e', 'process.exit(0)'],
        exitCode: 0,
        output: 'ok',
        ran: true,
      }),
    );
    const task = orch.create({
      projectId,
      goal: '写 note',
      scope: ['note.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    await orch.approveAndQueue(task.id);
    const done = await orch.dispatch(task.id);
    expect(done.verify_status).toBe('passed');
    expect(existsSync(join(done.workspace_path!, 'note.txt'))).toBe(true);

    const store = new CodingTaskStore(db);
    expect(() => store.assertCommandAllowed(done, ['rm', '-rf', '/'])).toThrow(/不在批准列表/);
    expect(() => store.assertPathInWorkspace(done, join(dir, 'not-workspace', 'x'))).toThrow(
      /越界/,
    );

    const escapeOrch = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({ files: { '../secret.txt': 'no' } }),
      dir,
      async () => ({
        argv: ['node', '-e', 'process.exit(0)'],
        exitCode: 0,
        output: 'ok',
        ran: true,
      }),
    );
    const escapeTask = escapeOrch.create({
      projectId,
      goal: '越界产物',
      scope: ['note.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    await escapeOrch.approveAndQueue(escapeTask.id);
    const escaped = await escapeOrch.dispatch(escapeTask.id);
    expect(escaped.status).toBe('failed');
    expect(escaped.error).toMatch(/越界/);
  });
});

describe('A20 结果不冒充验收', () => {
  it('执行器自报成功但独立测试失败时不通过；未跑保留未运行', async () => {
    const failOrch = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({ claimedSuccess: true, files: { 'note.txt': 'x' } }),
      dir,
      async () => ({ argv: ['check'], exitCode: 1, output: 'FAIL', ran: true }),
    );
    const t = failOrch.create({
      projectId,
      goal: '自报成功',
      scope: ['note.txt'],
      allowedCommands: [['check']],
    });
    await failOrch.approveAndQueue(t.id);
    const failed = await failOrch.dispatch(t.id);
    expect(failed.status).toBe('failed');
    expect(failed.verify_status).toBe('failed');
    expect(failed.error).toMatch(/独立验证失败/);
    expect(() => failOrch.accept(failed.id)).toThrow();

    const skipOrch = new CodingOrchestrator(
      db,
      new FakeCodingExecutor({ files: { 'note.txt': 'y' } }),
      dir,
      async () => ({ argv: [], exitCode: 0, output: '', ran: false }),
    );
    const t2 = skipOrch.create({
      projectId,
      goal: '未跑',
      scope: ['note.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    await skipOrch.approveAndQueue(t2.id);
    const skipped = await skipOrch.dispatch(t2.id);
    expect(skipped.verify_status).toBe('not_run');
    expect(skipped.status).toBe('pending_accept');
  });
});

describe('A21 幂等与重启', () => {
  it('重复派发同键去重；同键不同内容冲突；取消后晚到不覆盖；重启不明状态不盲目再派发', async () => {
    const store = new CodingTaskStore(db);
    const a = store.create({
      projectId,
      goal: '同一件事',
      scope: ['a.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
      dispatchKey: 'k1',
    });
    const again = store.create({
      projectId,
      goal: '同一件事',
      scope: ['a.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
      dispatchKey: 'k1',
    });
    expect(again.id).toBe(a.id);
    expect(() =>
      store.create({
        projectId,
        goal: '另一件事',
        scope: ['a.txt'],
        allowedCommands: [['node', '-e', 'process.exit(0)']],
        dispatchKey: 'k1',
      }),
    ).toThrow(/dispatch_key/);

    let resolveRun: (v: IndependentCheck) => void = () => undefined;
    const hang = new Promise<IndependentCheck>((r) => {
      resolveRun = r;
    });
    const slowExec = new FakeCodingExecutor({ files: { 'a.txt': '1' } });
    const origRun = slowExec.run.bind(slowExec);
    slowExec.run = async (task, ws, signal) => {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new IxaError(ErrorCodes.JOB_CANCELLED, '取消'));
          return;
        }
        const t = setTimeout(resolve, 5_000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new IxaError(ErrorCodes.JOB_CANCELLED, '取消'));
          },
          { once: true },
        );
      });
      return origRun(task, ws, signal);
    };
    const orch = new CodingOrchestrator(db, slowExec, dir, async () => hang);
    const t = orch.create({
      projectId,
      goal: '可取消',
      scope: ['a.txt'],
      allowedCommands: [['node', '-e', 'process.exit(0)']],
    });
    await orch.approveAndQueue(t.id);
    const dispatched = orch.dispatch(t.id);
    orch.cancel(t.id);
    const cancelled = await dispatched;
    expect(cancelled.status).toBe('cancelled');
    resolveRun({ argv: ['x'], exitCode: 0, output: 'late', ran: true });
    expect(orch.store.get(t.id).status).toBe('cancelled');

    store.prepareWorkspace(a.id, dir);
    store.approve({ taskId: a.id, workspacePath: store.get(a.id).workspace_path! });
    store.setStatus(a.id, 'running');
    expect(store.markUnknownRunning()).toBeGreaterThan(0);
    expect(store.get(a.id).status).toBe('unknown');
  });
});

describe('研究发现开草案', () => {
  it('未标记拒绝；标记后开草案不派发；同一发现幂等', () => {
    const research = new ResearchStore(db);
    const topic = research.createTopic({
      question: '有新版本吗',
      sources: [{ url: 'https://example.com/releases', kind: 'page' }],
    });
    const finding = research.insertFinding({
      topicId: topic.id,
      sourceId: research.listSources(topic.id)[0]!.id,
      title: 'v9 发布',
      url: 'https://example.com/releases/v9',
      excerpt: 'added sandbox flag',
      fingerprint: 'fp-v9',
      claimedPublishedAt: null,
      fetchedAt: new Date().toISOString(),
      relatedGoalId: null,
      relatedProjectId: null,
    });
    expect(finding).not.toBeNull();
    const orch = new CodingOrchestrator(db, new FakeCodingExecutor(), dir);
    expect(() => orch.draftFromFinding({ findingId: finding!.id, projectId })).toThrow(/值得行动/);
    research.setFindingAction(finding!.id, { actionWorthy: true, actionReason: '跟进' });
    const draft = orch.draftFromFinding({ findingId: finding!.id, projectId });
    expect(draft.status).toBe('draft');
    expect(draft.goal).toMatch(/v9 发布/);
    const again = orch.draftFromFinding({ findingId: finding!.id, projectId });
    expect(again.id).toBe(draft.id);
    expect(orch.store.get(draft.id).status).toBe('draft');
  });
});
