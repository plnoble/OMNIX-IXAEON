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
  return db
    .prepare(
      `SELECT id, goal, status, error, origin_run_id, acceptance_json,
              verify_status, verify_output, executor_report_json
       FROM coding_tasks WHERE id = ?`,
    )
    .get(taskId) as TaskReportRow;
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
    if (!this.host.db.open) return;
    // IXAEON_CODEX_EXE=none 是真机检查主动选替身，不算「没找到」
    const forcedFake = process.env.IXAEON_CODEX_EXE?.trim() === 'none';
    if (!forcedFake && this.host.codexLocator && this.host.codexLocator() === null) {
      this.write(taskId, codexMissingReport(taskReportRow(this.host.db, taskId)));
      return;
    }
    if (this.host.coding.store.runningCount() > 0) this.resumeAfterRunning = true;
    void this.drain();
  }

  onTaskSettled(taskId: string): void {
    if (!this.host.db.open) return;
    const row = taskReportRow(this.host.db, taskId);
    this.write(taskId, buildTaskReport(row));
    if (this.resumeAfterRunning && this.host.coding.store.runningCount() === 0) {
      this.resumeAfterRunning = false;
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (!this.host.db.open) return;
        const next = this.nextQueued();
        if (!next) return;
        const done = await this.host.coding
          .dispatch(next.id)
          .catch(() => this.host.coding.store.get(next.id));
        this.onTaskSettled(done.id);
      }
    } finally {
      this.draining = false;
    }
  }

  private nextQueued(): { id: string } | null {
    if (this.host.coding.store.runningCount() > 0) return null;
    return (
      (this.host.db
        .prepare(
          `SELECT t.id FROM coding_tasks t JOIN coding_approvals a ON a.id = t.approval_id
           WHERE t.status = 'queued' ORDER BY a.granted_at ASC LIMIT 1`,
        )
        .get() as { id: string } | undefined) ?? null
    );
  }

  private write(taskId: string, report: TaskReportMessage | null): void {
    if (!report) return;
    const task = taskReportRow(this.host.db, taskId);
    if (!task.origin_run_id) return;
    const conversationId = conversationForRun(this.host.db, task.origin_run_id);
    if (!conversationId) return;
    if (reportAlreadyWritten(this.host.db, taskId, report.meta.status)) return;
    this.host.conversations.appendMessage(conversationId, {
      role: 'assistant',
      content: report.content,
      meta: report.meta,
    });
    this.host.taskReportSink?.({ conversationId });
  }
}
