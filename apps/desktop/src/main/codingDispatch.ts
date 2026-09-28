import { ErrorCodes } from '@ixaeon/contracts';
import type { CodingOrchestrator, ConversationStore, CoreDatabase } from '@ixaeon/core';
import {
  buildTaskReport,
  codexMissingReport,
  conversationForRun,
  reportAlreadyWritten,
  type TaskReportMessage,
  type TaskReportRow,
} from './taskReport.js';

export function taskReportRow(db: CoreDatabase, taskId: string): TaskReportRow {
  return db.prepare('SELECT * FROM coding_tasks WHERE id = ?').get(taskId) as TaskReportRow;
}

export interface CodingDispatchHost {
  db: CoreDatabase;
  coding: CodingOrchestrator;
  conversations: ConversationStore;
  codexLocator?: (() => unknown) | null;
  taskReportSink?: ((e: { conversationId: string }) => void) | null;
}

export class CodingDispatch {
  private draining = false;
  private resumeAfterRunning = false;

  constructor(private readonly host: CodingDispatchHost) {}

  kick(taskId: string): void {
    if (!this.host.db.open || this.codexMissing(taskId)) return;
    if ((this.host.coding.store?.runningCount() ?? 0) > 0) this.resumeAfterRunning = true;
    setTimeout(() => void this.drain(), 0);
  }

  onTaskSettled(taskId: string): void {
    if (!this.host.db.open) return;
    this.write(taskId, buildTaskReport(taskReportRow(this.host.db, taskId)));
    if (this.resumeAfterRunning && this.host.coding.store.runningCount() === 0) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const skipped: string[] = [];
    try {
      for (;;) {
        if (!this.host.db.open) return;
        const next = this.nextQueued(skipped);
        if (!next || this.codexMissing(next.id)) {
          this.resumeAfterRunning = !next && (this.host.coding.store?.runningCount() ?? 0) > 0;
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
    } finally {
      this.draining = false;
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
