import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ErrorCodes,
  IxaError,
  type CodingApproval,
  type CodingTask,
  type CodingTaskStatus,
} from '@ixaeon/contracts';
import type { CoreDatabase } from '../db/database.js';
import { assertInside, isPathInside, normalizeLocalPath } from '../paths.js';

export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;

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
      input.contextDigest ??
      createHash('sha256')
        .update(`${goal}|${input.scope.join(',')}`)
        .digest('hex');
    this.db
      .prepare(
        `INSERT INTO coding_tasks (
           id, project_id, goal, scope_json, workspace_path, snapshot_ref, context_digest,
           allowed_commands_json, timeout_ms, status, version, approval_id, dispatch_key,
           generation, executor_name, executor_report_json, verify_status, verify_exit_code,
           verify_output, tests_modified, accepted_at, error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'draft', 1, NULL, ?, 0, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?)`,
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
      );
    return this.get(id);
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
    this.get(taskId);
    const ws = resolve(join(dataDir, 'workspaces', taskId));
    mkdirSync(ws, { recursive: true });
    this.db
      .prepare(
        `UPDATE coding_tasks SET workspace_path = ?, snapshot_ref = ?, status = 'waiting_approval', updated_at = ? WHERE id = ?`,
      )
      .run(ws, `workspace:${taskId}`, now, taskId);
    return this.get(taskId);
  }

  approve(input: {
    taskId: string;
    workspacePath: string;
    expiresAt?: string | null;
    now?: string;
  }): CodingApproval {
    const task = this.get(input.taskId);
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
