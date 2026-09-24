import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ErrorCodes,
  IxaError,
  type CodingApproval,
  type CodingTask,
  type CodingTaskStatus,
} from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { assertInside, isPathInside, normalizeLocalPath } from '../paths.js';
import { codingClientMayReadItem } from '../access.js';
import { copyProjectWorkspace } from './workspaceCopy.js';

export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * G04：当前正在进行的提问（runId）。提问期间建的编码任务记下这个归属，
 * ask() 只把这一轮自己建的任务带进回答。用异步上下文而不是函数参数：
 * 任务可能由 broker 的 propose_task 建，也可能由这一轮里别的代码建
 * （T2b 的会话替身就是这样），两条路都要标上。并发的两轮各有各的上下文，不串。
 */
const askRunStorage = new AsyncLocalStorage<string>();

/** 在这个提问的上下文里跑 fn。里面建的编码任务自动带上 runId。 */
export function withAskRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return askRunStorage.run(runId, fn);
}

/** 当前提问的 runId；不在提问里时为 null（手动建的任务没有归属）。 */
export function currentAskRunId(): string | null {
  return askRunStorage.getStore() ?? null;
}

function bool(v: unknown): boolean {
  return v === 1 || v === true;
}

function toTask(row: Record<string, unknown>): CodingTask {
  return {
    id: row['id'] as string,
    project_id: row['project_id'] as string,
    goal: row['goal'] as string,
    scope_json: row['scope_json'] as string,
    workspace_path: (row['workspace_path'] as string | null) ?? null,
    snapshot_ref: (row['snapshot_ref'] as string | null) ?? null,
    context_digest: row['context_digest'] as string,
    allowed_commands_json: row['allowed_commands_json'] as string,
    timeout_ms: row['timeout_ms'] as number,
    status: row['status'] as CodingTaskStatus,
    version: row['version'] as number,
    approval_id: (row['approval_id'] as string | null) ?? null,
    dispatch_key: (row['dispatch_key'] as string | null) ?? null,
    generation: row['generation'] as number,
    executor_name: (row['executor_name'] as string | null) ?? null,
    executor_report_json: (row['executor_report_json'] as string | null) ?? null,
    verify_status: (row['verify_status'] as CodingTask['verify_status']) ?? null,
    verify_exit_code: (row['verify_exit_code'] as number | null) ?? null,
    verify_output: (row['verify_output'] as string | null) ?? null,
    tests_modified: bool(row['tests_modified']),
    accepted_at: (row['accepted_at'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
  };
}

function toApproval(row: Record<string, unknown>): CodingApproval {
  return {
    id: row['id'] as string,
    task_id: row['task_id'] as string,
    task_version: row['task_version'] as number,
    digest: row['digest'] as string,
    workspace_path: row['workspace_path'] as string,
    snapshot_ref: (row['snapshot_ref'] as string | null) ?? null,
    allowed_commands_json: row['allowed_commands_json'] as string,
    granted_at: row['granted_at'] as string,
    expires_at: (row['expires_at'] as string | null) ?? null,
    revoked_at: (row['revoked_at'] as string | null) ?? null,
  };
}

export function approvalDigest(input: {
  taskId: string;
  version: number;
  projectId: string;
  goal: string;
  scope: string[];
  workspacePath: string;
  snapshotRef: string | null;
  allowedCommands: string[][];
  contextDigest: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskId: input.taskId,
        version: input.version,
        projectId: input.projectId,
        goal: input.goal,
        scope: input.scope,
        workspacePath: input.workspacePath,
        snapshotRef: input.snapshotRef,
        allowedCommands: input.allowedCommands,
        contextDigest: input.contextDigest,
      }),
    )
    .digest('hex');
}

/**
 * 批准是从「未批准」到「已排队」的一次转换，只能从 draft 或 waiting_approval 发起。
 * waiting_approval 覆盖两种合法情况：刚准备好工作区，以及批准后修改了任务
 * （bumpVersion 会把状态改回 waiting_approval，旧批准随之失效）。
 * 其余状态一律拒绝：已排队的不重复批准；执行中、待验收、已完成、失败、
 * 未知的任务，工作区里是执行器产物或失败现场，不能被重新复制覆盖。
 */
function assertApprovable(task: CodingTask): void {
  if (task.status === 'draft' || task.status === 'waiting_approval') return;
  throw new IxaError(
    ErrorCodes.CONFLICT,
    `任务当前状态为 ${task.status}，不能再次批准。已批准的任务不重复批准；需要重新批准请先修改任务。`,
  );
}

export class CodingTaskStore {
  constructor(private readonly db: CoreDatabase) {}

  create(input: {
    projectId: string;
    goal: string;
    scope: string[];
    allowedCommands: string[][];
    contextDigest?: string;
    timeoutMs?: number;
    dispatchKey?: string | null;
    now?: string;
  }): CodingTask {
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
      { id: string } | undefined;
    if (!project) throw new IxaError(ErrorCodes.NOT_FOUND, `项目不存在: ${input.projectId}`);
    const goal = input.goal.trim();
    if (goal.length === 0) throw new IxaError(ErrorCodes.VALIDATION_FAILED, '任务目标不能为空');
    if (input.scope.length === 0) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '必须指定可修改范围');
    }
    for (const rel of input.scope) {
      if (
        !rel ||
        rel.includes('\0') ||
        rel.includes('..') ||
        rel.startsWith('/') ||
        rel.startsWith('\\') ||
        /^[a-zA-Z]:/.test(rel)
      ) {
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `可修改范围非法：${rel}`);
      }
    }
    if (input.dispatchKey) {
      const existing = this.db
        .prepare('SELECT id, goal FROM coding_tasks WHERE dispatch_key = ?')
        .get(input.dispatchKey) as { id: string; goal: string } | undefined;
      if (existing) {
        if (existing.goal === goal) return this.get(existing.id);
        throw new IxaError(ErrorCodes.CONFLICT, `dispatch_key 已被不同任务使用: ${existing.id}`);
      }
    }
    const now = input.now ?? new Date().toISOString();
    const id = randomUUID();
    const contextDigest =
      input.contextDigest ?? this.buildSafeContextDigest(input.projectId, goal, input.scope);
    this.db
      .prepare(
        `INSERT INTO coding_tasks (
           id, project_id, goal, scope_json, workspace_path, snapshot_ref, context_digest,
           allowed_commands_json, timeout_ms, status, version, approval_id, dispatch_key,
           generation, executor_name, executor_report_json, verify_status, verify_exit_code,
           verify_output, tests_modified, accepted_at, error, created_at, updated_at, origin_run_id
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'draft', 1, NULL, ?, 0, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        goal,
        JSON.stringify(input.scope),
        contextDigest,
        JSON.stringify(input.allowedCommands),
        input.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        input.dispatchKey ?? null,
        now,
        now,
        // G04：提问期间建的任务记住是哪一轮（ask() 按它归属）。
        // 没在提问里建的（任务页手动建、旧数据）为 null，不出现在任何回答上。
        currentAskRunId(),
      );
    return this.get(id);
  }

  /**
   * 任务背景只含本项目、且编码客户端可读的条目。
   * 未分享的 personal/unassigned 不得进入 digest / 派发上下文。
   */
  buildSafeContextDigest(projectId: string, goal: string, scope: string[]): string {
    const rows = this.db
      .prepare(
        `SELECT id, statement, origin, type FROM items
         WHERE project_id = ? AND state = 'current' AND confirmation != 'rejected'`,
      )
      .all(projectId) as Array<{ id: string; statement: string; origin: string; type: string }>;
    const allowed = rows.filter((row) => codingClientMayReadItem(this.db, row.id));
    return createHash('sha256')
      .update(
        JSON.stringify({
          goal,
          scope,
          projectId,
          items: allowed.map((r) => ({ id: r.id, origin: r.origin, type: r.type })),
        }),
      )
      .digest('hex');
  }

  /** 派发给执行器的背景：不含未分享个人资料。 */
  taskBackground(task: CodingTask): { goal: string; statements: string[] } {
    const rows = this.db
      .prepare(
        `SELECT id, statement FROM items
         WHERE project_id = ? AND state = 'current' AND confirmation != 'rejected'`,
      )
      .all(task.project_id) as Array<{ id: string; statement: string }>;
    return {
      goal: task.goal,
      statements: rows
        .filter((row) => codingClientMayReadItem(this.db, row.id))
        .map((row) => row.statement),
    };
  }

  get(id: string): CodingTask {
    const row = this.db.prepare('SELECT * FROM coding_tasks WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `编码任务不存在: ${id}`);
    return toTask(row);
  }

  list(projectId?: string): CodingTask[] {
    const rows = projectId
      ? (this.db
          .prepare('SELECT * FROM coding_tasks WHERE project_id = ? ORDER BY created_at DESC')
          .all(projectId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM coding_tasks ORDER BY created_at DESC LIMIT 50')
          .all() as Array<Record<string, unknown>>);
    return rows.map(toTask);
  }

  runningCount(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM coding_tasks WHERE status = 'running'`).get() as {
        n: number;
      }
    ).n;
  }

  bumpVersion(id: string, patch: { goal?: string; scope?: string[]; now?: string }): CodingTask {
    const task = this.get(id);
    const now = patch.now ?? new Date().toISOString();
    const goal = patch.goal?.trim() ?? task.goal;
    const scope = patch.scope ?? (JSON.parse(task.scope_json) as string[]);
    this.db
      .prepare(
        `UPDATE coding_tasks SET goal = ?, scope_json = ?, version = version + 1,
                status = CASE WHEN status IN ('completed', 'cancelled') THEN status ELSE 'waiting_approval' END,
                updated_at = ? WHERE id = ?`,
      )
      .run(goal, JSON.stringify(scope), now, id);
    return this.get(id);
  }

  prepareWorkspace(taskId: string, dataDir: string, now = new Date().toISOString()): CodingTask {
    const task = this.get(taskId);
    // 准备工作区会把项目原文复制进去（覆盖同名文件）并把状态改回 waiting_approval。
    // 对已执行过的任务这么做，执行器产物和失败现场就被项目原文盖掉了。
    assertApprovable(task);
    const ws = resolve(join(dataDir, 'workspaces', taskId));
    mkdirSync(ws, { recursive: true });
    const project = this.db
      .prepare('SELECT root_path FROM projects WHERE id = ?')
      .get(task.project_id) as { root_path: string | null } | undefined;
    const root = project?.root_path?.trim() || null;
    let snapshotRef = `empty:${taskId}`;
    if (root) {
      const snap = copyProjectWorkspace(root, ws);
      snapshotRef = snap.snapshotRef;
    }
    this.db
      .prepare(
        `UPDATE coding_tasks SET workspace_path = ?, snapshot_ref = ?, status = 'waiting_approval', updated_at = ? WHERE id = ?`,
      )
      .run(ws, snapshotRef, now, taskId);
    return this.get(taskId);
  }

  /** 工作区内实际文件相对路径（不含目录）。 */
  listWorkspaceFiles(workspace: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else out.push(relative(workspace, abs).replaceAll('\\', '/'));
      }
    };
    if (existsSync(workspace)) walk(workspace);
    return out;
  }

  assertChangedPathsInScope(task: CodingTask, changed: string[]): void {
    const scope = (JSON.parse(task.scope_json) as string[]).map((s) => s.replaceAll('\\', '/'));
    for (const rel of changed) {
      const n = rel.replaceAll('\\', '/');
      this.assertPathInWorkspace(task, join(task.workspace_path!, n));
      const allowed = scope.some((s) => n === s || n.startsWith(`${s}/`));
      if (!allowed) {
        throw new IxaError(ErrorCodes.PATH_ESCAPE, `改动超出批准范围：${n}`);
      }
    }
  }

  approve(input: {
    taskId: string;
    workspacePath: string;
    expiresAt?: string | null;
    now?: string;
  }): CodingApproval {
    const task = this.get(input.taskId);
    assertApprovable(task);
    if (!task.workspace_path) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '批准前必须先准备隔离工作区');
    }
    const workspace = normalizeLocalPath(input.workspacePath);
    if (workspace !== normalizeLocalPath(task.workspace_path)) {
      throw new IxaError(ErrorCodes.PATH_ESCAPE, '批准的工作区与任务隔离目录不一致');
    }
    if (!existsSync(workspace)) {
      throw new IxaError(ErrorCodes.NOT_FOUND, `工作区不存在: ${workspace}`);
    }
    const scope = JSON.parse(task.scope_json) as string[];
    for (const rel of scope) {
      const abs = resolve(workspace, rel);
      assertInside(workspace, abs);
    }
    const allowed = JSON.parse(task.allowed_commands_json) as string[][];
    const digest = approvalDigest({
      taskId: task.id,
      version: task.version,
      projectId: task.project_id,
      goal: task.goal,
      scope,
      workspacePath: workspace,
      snapshotRef: task.snapshot_ref,
      allowedCommands: allowed,
      contextDigest: task.context_digest,
    });
    const now = input.now ?? new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO coding_approvals (id, task_id, task_version, digest, workspace_path, snapshot_ref, allowed_commands_json, granted_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        task.id,
        task.version,
        digest,
        workspace,
        task.snapshot_ref,
        task.allowed_commands_json,
        now,
        input.expiresAt ?? null,
      );
    this.db
      .prepare(
        `UPDATE coding_tasks SET approval_id = ?, status = 'queued', generation = generation + 1, updated_at = ? WHERE id = ?`,
      )
      .run(id, now, task.id);
    return this.getApproval(id);
  }

  getApproval(id: string): CodingApproval {
    const row = this.db.prepare('SELECT * FROM coding_approvals WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new IxaError(ErrorCodes.NOT_FOUND, `批准不存在: ${id}`);
    return toApproval(row);
  }

  liveApproval(task: CodingTask, now = new Date().toISOString()): CodingApproval {
    if (!task.approval_id) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '没有批准，拒绝执行');
    }
    const approval = this.getApproval(task.approval_id);
    if (approval.revoked_at) {
      throw new IxaError(ErrorCodes.PERMISSION_REVOKED, '批准已撤销');
    }
    if (approval.expires_at && approval.expires_at <= now) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '批准已过期');
    }
    if (approval.task_version !== task.version) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '任务已修改，旧批准失效');
    }
    const scope = JSON.parse(task.scope_json) as string[];
    const allowed = JSON.parse(task.allowed_commands_json) as string[][];
    const expected = approvalDigest({
      taskId: task.id,
      version: task.version,
      projectId: task.project_id,
      goal: task.goal,
      scope,
      workspacePath: task.workspace_path ?? '',
      snapshotRef: task.snapshot_ref,
      allowedCommands: allowed,
      contextDigest: task.context_digest,
    });
    if (expected !== approval.digest) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, '批准摘要与当前任务不一致');
    }
    if (!task.workspace_path || approval.workspace_path !== task.workspace_path) {
      throw new IxaError(ErrorCodes.PATH_ESCAPE, '工作区与批准绑定不一致');
    }
    return approval;
  }

  setStatus(
    id: string,
    status: CodingTaskStatus,
    patch: Partial<{
      executorName: string | null;
      executorReportJson: string | null;
      verifyStatus: CodingTask['verify_status'];
      verifyExitCode: number | null;
      verifyOutput: string | null;
      testsModified: boolean;
      acceptedAt: string | null;
      error: string | null;
      now: string;
    }> = {},
  ): CodingTask {
    const now = patch.now ?? new Date().toISOString();
    const current = this.get(id);
    this.db
      .prepare(
        `UPDATE coding_tasks SET status = ?, executor_name = ?,
                executor_report_json = ?, verify_status = ?, verify_exit_code = ?,
                verify_output = ?, tests_modified = ?, accepted_at = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        patch.executorName ?? current.executor_name,
        patch.executorReportJson ?? current.executor_report_json,
        patch.verifyStatus !== undefined ? patch.verifyStatus : current.verify_status,
        patch.verifyExitCode !== undefined ? patch.verifyExitCode : current.verify_exit_code,
        patch.verifyOutput !== undefined ? patch.verifyOutput : current.verify_output,
        (patch.testsModified ?? current.tests_modified) ? 1 : 0,
        patch.acceptedAt !== undefined ? patch.acceptedAt : current.accepted_at,
        patch.error !== undefined ? patch.error : current.error,
        now,
        id,
      );
    return this.get(id);
  }

  /**
   * 删除已结束或未派发的任务。执行中必须先取消。
   * 工作区目录由编排层按 dataDir 删除，这里只删库记录。
   */
  remove(id: string): CodingTask {
    const task = this.get(id);
    if (task.status === 'running') {
      throw new IxaError(ErrorCodes.CONFLICT, '正在执行的任务不能删除，请先取消');
    }
    this.db.prepare('DELETE FROM coding_tasks WHERE id = ?').run(id);
    return task;
  }

  cancel(id: string, now = new Date().toISOString()): CodingTask {
    const task = this.get(id);
    this.db
      .prepare(
        `UPDATE coding_tasks SET status = 'cancelled', generation = generation + 1, error = ?, updated_at = ? WHERE id = ?`,
      )
      .run('用户取消', now, id);
    void task;
    return this.get(id);
  }

  markUnknownRunning(now = new Date().toISOString()): number {
    const info = this.db
      .prepare(
        `UPDATE coding_tasks SET status = 'unknown', error = '应用重启时执行状态不明，未盲目再派发', updated_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(now);
    return info.changes;
  }

  assertCommandAllowed(task: CodingTask, argv: string[]): void {
    const allowed = JSON.parse(task.allowed_commands_json) as string[][];
    const ok = allowed.some(
      (cmd) => cmd.length === argv.length && cmd.every((part, i) => part === argv[i]),
    );
    if (!ok) {
      throw new IxaError(ErrorCodes.PERMISSION_DENIED, `命令不在批准列表：${argv.join(' ')}`);
    }
  }

  assertPathInWorkspace(task: CodingTask, target: string): void {
    if (!task.workspace_path) {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, '任务没有隔离工作区');
    }
    if (!isPathInside(task.workspace_path, target)) {
      throw new IxaError(ErrorCodes.PATH_ESCAPE, `路径越界：${target}`);
    }
  }
}
