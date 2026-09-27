import type { CoreDatabase } from '@ixaeon/core';

/** 回报里最多列几个改动文件，多了写总数。 */
const MAX_CHANGED = 10;

/** 失败回报里验证输出只取头几行。 */
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
}

/** 一条本地生成的回报消息：正文 + meta（同一任务同一状态只写一次）。 */
export interface TaskReportMessage {
  content: string;
  meta: { kind: 'task_report'; taskId: string; status: string };
}

/** 按 origin_run_id 找到发起这一轮的对话；没有就返回 null（手建的任务不回报）。 */
export function conversationForRun(db: CoreDatabase, runId: string): string | null {
  const row = db
    .prepare('SELECT conversation_id FROM messages WHERE run_id = ? LIMIT 1')
    .get(runId) as { conversation_id: string } | undefined;
  return row?.conversation_id ?? null;
}

/** 这个任务这个状态的回报写过没有。 */
export function reportAlreadyWritten(db: CoreDatabase, taskId: string, status: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS n FROM messages WHERE json_extract(meta_json, '$.kind') = 'task_report'
         AND json_extract(meta_json, '$.taskId') = ? AND json_extract(meta_json, '$.status') = ?`,
    )
    .get(taskId, status) as { n: number } | undefined;
  return row != null;
}

function goalFirstLine(goal: string): string {
  return goal.split('\n')[0]!.trim();
}

function acceptanceLines(json: string | null): string[] {
  if (!json) return [];
  const list = JSON.parse(json) as unknown;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function changedPaths(reportJson: string | null): string[] {
  if (!reportJson) return [];
  const report = JSON.parse(reportJson) as { changedPaths?: unknown };
  const paths = Array.isArray(report.changedPaths) ? report.changedPaths : [];
  return paths.filter((p): p is string => typeof p === 'string');
}

/** 验证结果那一行：通过 / 没跑（写原因）/ 还没有独立验收。 */
function verifyLine(row: TaskReportRow): string {
  if (row.verify_status === 'passed') return '验证通过';
  const reason = row.verify_status === 'not_run' ? row.verify_output?.trim() : '';
  if (reason && !reason.includes('没有有效验证命令')) return `验证没跑：${reason}`;
  return '还没有独立验收';
}

/** 等你验收的回报：目标、验收条件、验证结果、改动文件、下一步。 */
function pendingAcceptReport(row: TaskReportRow): string {
  const lines = [`「${goalFirstLine(row.goal)}」做完了，等你验收。`];
  const acceptance = acceptanceLines(row.acceptance_json);
  if (acceptance.length > 0) {
    lines.push('验收条件：');
    for (const item of acceptance) lines.push(`- ${item}`);
  }
  lines.push(verifyLine(row));
  const changed = changedPaths(row.executor_report_json);
  if (changed.length > 0) {
    const shown = changed.slice(0, MAX_CHANGED);
    lines.push(
      `改了 ${shown.join('、')}${changed.length > MAX_CHANGED ? `，共 ${changed.length} 个` : ''}`,
    );
  }
  lines.push('去任务页看改动，点接受。');
  return lines.join('\n');
}

/** 失败的回报：目标第一行、原因、验证输出的头几行。 */
function failedReport(row: TaskReportRow): string {
  const lines = [`「${goalFirstLine(row.goal)}」没做成。`];
  lines.push(row.error?.trim() ? `原因：${row.error.trim()}` : '原因：没有记录');
  const head = (row.verify_output ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_OUTPUT_LINES);
  if (head.length > 0) lines.push(head.join('\n'));
  return lines.join('\n');
}

/** 按任务当前状态生成回报；不该回报的状态返回 null。 */
export function buildTaskReport(row: TaskReportRow): TaskReportMessage | null {
  if (!['pending_accept', 'failed', 'cancelled'].includes(row.status)) return null;
  const content =
    row.status === 'pending_accept'
      ? pendingAcceptReport(row)
      : row.status === 'failed'
        ? failedReport(row)
        : `「${goalFirstLine(row.goal)}」取消了。`;
  return { content, meta: { kind: 'task_report', taskId: row.id, status: row.status } };
}

/** 找不到 Codex 时的回报：不派发，任务留在已批准。 */
export function codexMissingReport(row: TaskReportRow): TaskReportMessage {
  return {
    content: `「${goalFirstLine(row.goal)}」没找到 Codex，装好后在任务页点派发。`,
    meta: { kind: 'task_report', taskId: row.id, status: 'codex_missing' },
  };
}
