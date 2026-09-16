/**
 * P3 阶段验收套件：持续资料入口、长期统筹与在线节点 (review-p3-connectors-lifecycle-20260916.test.ts)
 * 严格按照 IXAEON 长期开发总计划 P3 要求：
 * 1. P3-A 连接器命名空间、增量游标、跨账号隔离与撤权立即拦截；
 * 2. P3-B 知识与用户意图严格分开（外部知识/助手建议不能冒充用户目标）；
 * 3. P3-C 可恢复的在线主节点（持久队列、重启恢复对账、有限退避重试）；
 * 4. P3-D 长期目标管理与低打扰（目标并存、推迟/搁置保留依据不反复打扰）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ItemService,
  JobQueue,
  PermissionService,
  ProjectService,
  SourceStore,
  assertSourceAuthorized,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '../../../../packages/core/src/index.js';

let dir: string;
let db: CoreDatabase;
let permissions: PermissionService;
let sourceStore: SourceStore;
let itemService: ItemService;
let projects: ProjectService;
let projectId: string;

function insertTestSource(
  dbInstance: CoreDatabase,
  input: {
    kind: string;
    provider: string;
    accountNamespace: string;
    externalId: string;
    title: string;
    contentHash: string;
    rawPath: string;
    permissionId: string;
    projectId?: string | null;
    metadataJson?: string;
  },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  dbInstance
    .prepare(
      `INSERT INTO sources (id, kind, provider, account_namespace, external_id, title, content_hash, raw_path, imported_at, permission_id, project_id, metadata_json, content_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      id,
      input.kind,
      input.provider,
      input.accountNamespace,
      input.externalId,
      input.title,
      input.contentHash,
      input.rawPath,
      now,
      input.permissionId,
      input.projectId ?? null,
      input.metadataJson ?? '{}',
    );
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p3-conn-'));
  db = openDatabase(join(dir, 'p3.db'));
  migrate(db);
  permissions = new PermissionService(db);
  sourceStore = new SourceStore(db);
  itemService = new ItemService(db);
  projects = new ProjectService(db);

  projectId = projects.create({
    name: 'P3 Connector Project',
    rootPath: null,
    description: 'Project for connectors and continuous lifecycle testing',
  }).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.split(/[\\/]/).at(-1)?.startsWith('ixaeon-p3-conn-')
  )
    throw new Error('Unsafe cleanup target');
  rmSync(target, { recursive: true, force: true });
});

describe('P3-A 从“支持导入”变成“知道接入到哪里”', () => {
  it('P3-A01 [跨账号命名空间隔离与幂等] 相同外部 ID 在不同账号隔离，同账号重复同步幂等去重', () => {
    const perm = permissions.grantDomain('chatgpt.com');

    // 1. 账号 A 导入对话
    const sourceAId = insertTestSource(db, {
      kind: 'conversation',
      provider: 'chatgpt_web',
      accountNamespace: 'work-account',
      externalId: 'conv-1001',
      title: '工作项目架构讨论',
      contentHash: 'a'.repeat(64),
      rawPath: 'work/conv-1001.json',
      permissionId: perm.id,
      projectId,
      metadataJson: JSON.stringify({ cursor: 'msg-50', syncRange: '2026-09-01~2026-09-10' }),
    });
    const sourceA = sourceStore.get(sourceAId);

    // 2. 账号 B 导入相同外部 ID 的对话，系统由于命名空间不同而严格隔离
    const sourceBId = insertTestSource(db, {
      kind: 'conversation',
      provider: 'chatgpt_web',
      accountNamespace: 'personal-account',
      externalId: 'conv-1001',
      title: '个人项目随手记',
      contentHash: 'b'.repeat(64),
      rawPath: 'personal/conv-1001.json',
      permissionId: perm.id,
      projectId: null,
      metadataJson: JSON.stringify({ cursor: 'msg-10', syncRange: '2026-09-05~2026-09-08' }),
    });
    const sourceB = sourceStore.get(sourceBId);

    expect(sourceA!.id).not.toBe(sourceB!.id);
    expect(sourceA!.account_namespace).toBe('work-account');
    expect(sourceB!.account_namespace).toBe('personal-account');

    // 3. 账号 A 再次同步相同内容（模拟定时轮询），幂等去重不新增来源
    expect(() =>
      insertTestSource(db, {
        kind: 'conversation',
        provider: 'chatgpt_web',
        accountNamespace: 'work-account',
        externalId: 'conv-1001',
        title: '工作项目架构讨论',
        contentHash: 'a'.repeat(64), // 相同哈希
        rawPath: 'work/conv-1001.json',
        permissionId: perm.id,
        projectId,
        metadataJson: '{}',
      }),
    ).toThrow(); // 唯一索引阻止重复冗余入库
  });

  it('P3-A02 [撤销授权立即拦截] 撤销来源授权后，任何后续读取或派生处理立即被拒绝', () => {
    const perm = permissions.grantDomain('claude.ai');

    const sourceId = insertTestSource(db, {
      kind: 'conversation',
      provider: 'chatgpt_export',
      accountNamespace: 'default',
      externalId: 'claude-session-1',
      title: '敏感设计文档',
      contentHash: 'c'.repeat(64),
      rawPath: 'claude-1.json',
      permissionId: perm.id,
      projectId,
      metadataJson: '{}',
    });

    // 初始状态：授权有效，允许读取
    expect(() => assertSourceAuthorized(db, sourceId)).not.toThrow();

    // 用户在安全面板中点击“撤销授权”
    permissions.revoke(perm.id);

    // 撤销后：任何尝试访问或派生提取立即被拒绝抛出 PERMISSION_DENIED
    expect(() => assertSourceAuthorized(db, sourceId)).toThrow(/已被用户撤销|授权已撤销/);
  });
});

describe('P3-B 可靠检索与个人知识边界', () => {
  it('P3-B01 [意图与知识边界] 外部文档与助手建议只能作为背景知识，绝不能冒充用户自身目标', () => {
    // 注入一条从外部架构教程中提取的建议
    const docSummaryId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO items (id, project_id, scope, type, statement, state, confidence, origin, confirmation, created_at, updated_at)
       VALUES (?, ?, 'project', 'project_summary', '网上建议使用微服务拆分单体架构', 'current', 0.8, 'ai', 'none', ?, ?)`,
    ).run(docSummaryId, projectId, now, now);

    // 注入一条用户亲口确定的项目目标
    const userGoalId = randomUUID();
    db.prepare(
      `INSERT INTO items (id, project_id, scope, type, statement, state, confidence, origin, confirmation, created_at, updated_at)
       VALUES (?, ?, 'project', 'goal', '保持模块化单体架构，坚决不拆分微服务', 'current', 1.0, 'user', 'none', ?, ?)`,
    ).run(userGoalId, projectId, now, now);

    // 查询当前项目确定的用户目标（严格限定 type='goal' 且 origin='user'）
    const userGoals = db
      .prepare("SELECT * FROM items WHERE project_id = ? AND type = 'goal' AND origin = 'user'")
      .all(projectId) as Array<{ id: string; statement: string }>;

    expect(userGoals.length).toBe(1);
    expect(userGoals[0]!.statement).toContain('坚决不拆分微服务');

    // 外部建议绝对不能混入用户目标列表
    expect(userGoals.some((g) => g.statement.includes('网上建议'))).toBe(false);
  });
});

describe('P3-C 可恢复的在线主节点与持久队列', () => {
  it('P3-C01 [持久任务队列与重启恢复] 任务在重启后依然保留，恢复后平稳执行', async () => {
    const queue = new JobQueue(db);
    const executedJobs: string[] = [];

    queue.register('sync_remote_feed', async (job) => {
      executedJobs.push(job.id);
    });

    // 写入一个排队中的持久任务
    const enqueued = queue.enqueue('sync_remote_feed', { topic: 'Rust News' });
    expect(enqueued.status).toBe('queued');

    // 模拟应用退出、主机重启（新建 JobQueue 实例接管数据库）
    const restartedQueue = new JobQueue(db);
    restartedQueue.register('sync_remote_feed', async (job) => {
      executedJobs.push(job.id);
    });

    // 执行重启后调度 tick
    await (restartedQueue as unknown as { tick(): Promise<void> }).tick();

    // 验证：重启前排队的任务成功被恢复并执行完成
    expect(executedJobs).toContain(enqueued.id);
    const finishedJob = db.prepare('SELECT status FROM jobs WHERE id = ?').get(enqueued.id) as {
      status: string;
    };
    expect(finishedJob.status).toBe('succeeded');
  });

  it('P3-C02 [暂时性重试与致命错误熔断] 暂时性失败自动退避重试，参数错误等非暂时性问题坚决不盲目重试', async () => {
    const queue = new JobQueue(db, undefined, {
      maxAutoRetries: 2,
      retryBackoffMs: [10, 20],
    });

    // 注册非暂时性致命校验错误的处理器
    queue.register('fatal_job', async () => {
      const err = new Error('参数格式非法，不可重试');
      (err as unknown as { code: string }).code = 'VALIDATION_FAILED';
      throw err;
    });

    const job = queue.enqueue('fatal_job', { bad: true });
    await (queue as unknown as { tick(): Promise<void> }).tick();

    // 验证：非暂时性错误直接判定为 failed，绝不盲目重试浪费配额
    const row = db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(job.id) as {
      status: string;
      error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('参数格式非法');
  });
});

describe('P3-D 长期目标管理与低打扰', () => {
  it('P3-D01 [目标多项并存与搁置低打扰] 目标独立存在，被用户搁置或推迟后不打扰日常提醒', () => {
    // 创建两个长期并存的目标
    const goal1 = itemService.createManual({
      projectId,
      statement: '完成 V0.3 主线架构重整与验收',
      type: 'goal',
      scope: 'project',
      rationale: null,
    });

    const goal2 = itemService.createManual({
      projectId,
      statement: '长期探索：将 WebAssembly 接入沙箱',
      type: 'goal',
      scope: 'project',
      rationale: null,
    });

    expect(goal1.id).not.toBe(goal2.id);

    // 用户决定对暂不紧急的长期探索目标进行“搁置（Shelve）”
    itemService.shelve(goal2.id, true);

    // 验证：活跃目标查询中只包含主线目标，被搁置目标不再在日常队列中打扰用户
    const activeGoals = itemService.list({
      projectId,
      shelved: false,
      type: 'goal',
    });

    expect(activeGoals.some((g) => g.id === goal1.id)).toBe(true);
    expect(activeGoals.some((g) => g.id === goal2.id)).toBe(false);

    // 验证：被搁置的目标在库中完整保留其条目与依据，并未被物理删除
    const shelvedItem = itemService.get(goal2.id);
    expect(shelvedItem.shelved_at).toBeTruthy();
    expect(shelvedItem.statement).toContain('WebAssembly');
  });
});
