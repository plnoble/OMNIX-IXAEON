import { landingText, type CoreDatabase } from '@ixaeon/core';

const MAX_CHANGED = 10;
const MAX_OUTPUT_LINES = 8;

export interface TaskReportRow {
  id: string;
  goal: string;
  status: string;
  error: string | null;
  origin_run_id: string | null;
  acceptance_json: string | null;
  verify_status: string | null;
  verify_output: string | null;
  executor_report_json: string | null;
  // D4：落地结果（迁移 38）。
  applied_ref: string | null;
  applied_at: string | null;
  apply_error: string | null;
}

export interface TaskReportMessage {
  content: string;
  meta: { kind: 'task_report'; taskId: string; status: string };
}

export function conversationForRun(db: CoreDatabase, runId: string): string | null {
  const row = db
    .prepare('SELECT conversation_id FROM messages WHERE run_id = ? LIMIT 1')
    .get(runId) as { conversation_id: string } | undefined;
  return row?.conversation_id ?? null;
}

export function reportAlreadyWritten(db: CoreDatabase, taskId: string, status: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages WHERE json_extract(meta_json, '$.kind') = 'task_report' AND json_extract(meta_json, '$.taskId') = ? AND json_extract(meta_json, '$.status') = ?`,
    )
    .get(taskId, status);
  return row != null;
}

const firstLine = (goal: string) => goal.split('\n')[0]!.trim();

function stringList(json: string | null, field?: string): string[] {
  if (!json) return [];
  const parsed = JSON.parse(json) as unknown;
  const list = field ? (parsed as Record<string, unknown>)[field] : parsed;
  return Array.isArray(list)
    ? list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
}

function verifyLine(row: TaskReportRow): string {
  if (row.verify_status === 'passed') return '验证通过';
  const reason = row.verify_status === 'not_run' ? row.verify_output?.trim() : '';
  return reason && !reason.includes('没有有效验证命令') ? `验证没跑：${reason}` : '还没有独立验收';
}

function pendingAccept(row: TaskReportRow): string {
  const lines = [`「${firstLine(row.goal)}」做完了，等你验收。`];
  const acceptance = stringList(row.acceptance_json);
  if (acceptance.length > 0) lines.push('验收条件：', ...acceptance.map((a) => `- ${a}`));
  lines.push(verifyLine(row));
  const changed = stringList(row.executor_report_json, 'changedPaths');
  if (changed.length > 0)
    lines.push(
      `改了 ${changed.slice(0, MAX_CHANGED).join('、')}${changed.length > MAX_CHANGED ? `，共 ${changed.length} 个` : ''}`,
    );
  lines.push('去任务页看改动，点接受。');
  return lines.join('\n');
}

function failed(row: TaskReportRow): string {
  const head = (row.verify_output ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l)
    .slice(0, MAX_OUTPUT_LINES);
  return [
    `「${firstLine(row.goal)}」没做成。`,
    row.error?.trim() ? `原因：${row.error.trim()}` : '原因：没有记录',
    ...head,
  ].join('\n');
}

const reportOf = (row: TaskReportRow, content: string, status: string): TaskReportMessage => ({
  content,
  meta: { kind: 'task_report', taskId: row.id, status },
});

/**
 * D4（契约 6）：接受之后的落地回报，追加在「等你验收」那条后面（文案与任务页共用 landingText）。
 */
export function landingReport(row: TaskReportRow): TaskReportMessage | null {
  if (row.status !== 'completed') return null;
  if (row.applied_ref && /^ixaeon\//.test(row.applied_ref)) {
    return reportOf(row, landingText(row), 'landed_branch');
  }
  if (row.applied_ref) {
    return reportOf(
      row,
      `没能建分支（${row.apply_error ?? '原因未记录'}），改动包在 ${row.applied_ref}`,
      'landed_patch',
    );
  }
  if (row.apply_error) return reportOf(row, `没能落地（${row.apply_error}）。`, 'landing_denied');
  return reportOf(row, landingText(row), 'no_changes');
}

export function buildTaskReport(row: TaskReportRow): TaskReportMessage | null {
  if (row.status === 'pending_accept') return reportOf(row, pendingAccept(row), row.status);
  if (row.status === 'failed') return reportOf(row, failed(row), row.status);
  if (row.status === 'cancelled')
    return reportOf(row, `「${firstLine(row.goal)}」取消了。`, row.status);
  return null;
}

export function codexMissingReport(row: TaskReportRow): TaskReportMessage {
  return reportOf(
    row,
    `「${firstLine(row.goal)}」没找到 Codex，装好后在任务页点派发。`,
    'codex_missing',
  );
}
