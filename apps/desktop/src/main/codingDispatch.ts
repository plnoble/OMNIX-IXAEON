import { ErrorCodes } from '@ixaeon/contracts';
import type { CodingOrchestrator, ConversationStore, CoreDatabase } from '@ixaeon/core';
import {
  buildTaskReport,
  codexMissingReport,
  conversationForRun,
  landingReport,
  reportAlreadyWritten,
  type TaskReportMessage,
  type TaskReportRow,
} from './taskReport.js';
import type { ExecutorPlan } from './codingExecutor.js';

export function taskReportRow(db: CoreDatabase, taskId: string): TaskReportRow {
  return db.prepare('SELECT * FROM coding_tasks WHERE id = ?').get(taskId) as TaskReportRow;
}

export interface CodingDispatchHost {
  db: CoreDatabase;
  coding: CodingOrchestrator;
  conversations: ConversationStore;
  codexLocator?: (() => unknown) | null;
  taskReportSink?: ((e: { conversationId: string }) => void) | null;
  /** D7b：按设置选执行器的计划；没有（旧宿主）按 Codex 走，行为不变。 */
  executorPlan?: () => ExecutorPlan;
}

const EXECUTOR_MISSING_TEXT: Record<'model_name' | 'model_key', string> = {
  model_name:
    '编码任务停在排队里：没有选「我的模型」用的模型。去设置的「编码任务交给谁」选一个，选好后在任务页点派发。',
  model_key:
    '编码任务停在排队里：没有配置「我的模型」用的 API Key。去设置的「模型接入」填上，再来任务页点派发。',
};

/** D7b：选了「我的模型」但缺模型/缺 Key 的回报（同一任务只写一次）。 */
function executorMissingReport(
  row: TaskReportRow,
  missing: 'model_name' | 'model_key',
): {
  content: string;
  meta: { kind: 'task_report'; taskId: string; status: string };
} {
  const first = row.goal.split('\n')[0]!.trim();
  return {
    content: `「${first}」${EXECUTOR_MISSING_TEXT[missing]}`,
    meta: { kind: 'task_report', taskId: row.id, status: 'executor_missing' },
  };
}

export class CodingDispatch {
  private resumeAfterRunning = false;

  constructor(private readonly host: CodingDispatchHost) {}

  kick(taskId: string): void {
    if (!this.host.db.open) return;
    const plan = this.host.executorPlan?.();
    if (plan && plan.use === 'none') {
      this.writeExecutorMissing(taskId, plan.missing);
      return;
    }
    if (plan?.use !== 'model' && this.codexMissing(taskId)) return;
    if ((this.host.coding.store?.runningCount() ?? 0) > 0) this.resumeAfterRunning = true;
    setTimeout(() => void this.drain(), 0);
  }

  /** D7b：缺模型/缺 Key 时回报（同任务只写一次），停在排队。 */
  private writeExecutorMissing(taskId: string, missing: 'model_name' | 'model_key'): void {
    if (!this.host.db.open) return;
    const row = taskReportRow(this.host.db, taskId);
    if (reportAlreadyWritten(this.host.db, taskId, 'executor_missing')) return;
    this.write(taskId, executorMissingReport(row, missing));
  }

  onTaskSettled(taskId: string): void {
    if (!this.host.db.open) return;
    this.write(taskId, buildTaskReport(taskReportRow(this.host.db, taskId)));
    if (this.resumeAfterRunning && this.host.coding.store.runningCount() === 0) void this.drain();
  }

  /** D4：接受之后的落地回报（追加，不改写「等你验收」那条）。 */
  writeLanding(taskId: string): void {
    if (!this.host.db.open) return;
    this.write(taskId, landingReport(taskReportRow(this.host.db, taskId)));
  }

  private async drain(): Promise<void> {
    const skipped: string[] = [];
    for (;;) {
      if (!this.host.db.open) return;
      const next = this.nextQueued(skipped);
      if (!next) {
        this.resumeAfterRunning = (this.host.coding.store?.runningCount() ?? 0) > 0;
        return;
      }
      const plan = this.host.executorPlan?.();
      if (plan && plan.use === 'none') {
        this.writeExecutorMissing(next.id, plan.missing);
        skipped.push(next.id);
        continue;
      }
      // 选了「我的模型」就不做「本机没装 Codex」的检查
      if (plan?.use !== 'model' && this.codexMissing(next.id)) {
        this.resumeAfterRunning = false;
        return;
      }
      const done = await this.host.coding.dispatch(next.id).catch((err: unknown) => {
        // 互斥拒绝：等当前任务结束再来；别的拒绝：任务照旧排队，本轮跳过不卡后面的
        const conflict = (err as { code?: string })?.code === ErrorCodes.CONFLICT;
        this.resumeAfterRunning = conflict;
        if (!conflict) skipped.push(next.id);
        return null;
      });
      if (!done && this.resumeAfterRunning) return;
      if (!done) continue;
      this.resumeAfterRunning = false;
      this.onTaskSettled(done.id);
    }
  }

  private codexMissing(taskId: string): boolean {
    if (process.env.IXAEON_CODEX_EXE?.trim() === 'none') return false;
    if (!this.host.codexLocator || this.host.codexLocator() !== null) return false;
    this.write(taskId, codexMissingReport(taskReportRow(this.host.db, taskId)));
    return true;
  }

  private nextQueued(skip: string[] = []): { id: string } | null {
    if (this.host.coding.store.runningCount() > 0) return null;
    const notSkipped = skip.length ? ` AND t.id NOT IN (${skip.map(() => '?').join(',')})` : '';
    const row = this.host.db
      .prepare(
        `SELECT t.id FROM coding_tasks t JOIN coding_approvals a ON a.id = t.approval_id
         WHERE t.status = 'queued'${notSkipped} ORDER BY a.granted_at ASC, a.rowid ASC LIMIT 1`,
      )
      .get(...skip) as { id: string } | undefined;
    return row ?? null;
  }

  private write(taskId: string, report: TaskReportMessage | null): void {
    const task = report ? taskReportRow(this.host.db, taskId) : null;
    const run = task?.origin_run_id;
    const conversationId = run ? conversationForRun(this.host.db, run) : null;
    if (!report || !conversationId) return;
    if (reportAlreadyWritten(this.host.db, taskId, report.meta.status)) return;
    this.host.conversations.appendMessage(conversationId, {
      role: 'assistant',
      content: report.content,
      meta: report.meta,
    });
    this.host.taskReportSink?.({ conversationId });
  }
}
