/**
 * P3：聊天时带上「项目近况」。对话选了项目时，由代码现查、现拼一段
 * （最近提交 + 最近编码代理会话 + 编码任务）接在记忆后面派给 Hermes。
 * 见 docs/委派/P3-项目进展简报.md：
 * - 登记读取是门槛：没做过目录登记读取（project_snapshot 来源）的项目不跑 git；
 * - 整段 ≤2000 字：先截提交（最旧先截），再截会话，最后才截任务；
 * - counts 是实际带上的条数；block 为空串表示没什么可带的。
 */
import { execFileSync } from 'node:child_process';
import type { CoreDatabase } from '../db/database.js';
import { isPathInside } from '../paths.js';

/** 编码任务的中文状态（同待办页 Todos 的对照表）。 */
const STATUS_ZH: Record<string, string> = {
  draft: '草稿',
  waiting_approval: '等批准',
  queued: '排队中',
  running: '进行中',
  pending_verify: '等验证',
  pending_accept: '等你验收',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态不明',
};

const MAX_BRIEF_CHARS = 2000;

export interface ProjectBriefCounts {
  commits: number;
  sessions: number;
  tasks: number;
}

/** 跑 git log（可注入替换，测试超时路径用）；失败由调用方兜住。 */
function runGitLog(root: string): string {
  return execFileSync(
    'git',
    ['-C', root, 'log', '--since=14.days', '-n', '20', '--pretty=format:%ad %s', '--date=short'],
    { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString();
}

export function buildProjectBrief(
  db: CoreDatabase,
  projectId: string,
  opts?: { runGit?: (root: string) => string },
): { block: string; counts: ProjectBriefCounts } {
  const empty = { block: '', counts: { commits: 0, sessions: 0, tasks: 0 } };
  const project = db.prepare('SELECT id, root_path FROM projects WHERE id = ?').get(projectId) as
    { id: string; root_path: string | null } | undefined;
  if (!project) return empty;

  // 登记读取是门槛：登记目录时用户才同意把 git 摘要交给模型分析，这里不扩大范围。
  // G02：门槛还要看授权**仍有效**，且覆盖项目当前的根目录（isPathInside，
  // 不是两者相等——授权了上级文件夹、项目根目录是其子目录时照样跑）。
  // 快照授权被撤销、或项目换了根目录跑到授权范围外 → 不跑：已有快照不能充当永久授权。
  const snapshot = db
    .prepare(
      `SELECT p.locator AS locator FROM sources s JOIN permissions p ON p.id = s.permission_id
        WHERE s.project_id = ? AND s.kind = 'project_snapshot' AND p.status = 'active'
        ORDER BY s.captured_at DESC LIMIT 1`,
    )
    .get(projectId) as { locator: string } | undefined;
  const runGit = opts?.runGit ?? runGitLog;
  let commitLines: string[] = [];
  if (snapshot && project.root_path && isPathInside(snapshot.locator, project.root_path)) {
    try {
      commitLines = runGit(project.root_path)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      /* 不是 git 仓库、超时等：跳过提交那块，不影响其余 */
    }
  }

  // G02：编码代理会话只取授权仍有效的来源（与其它读取入口同一把尺子：
  // permissions.status = 'active'）。撤销了读取授权的会话不再进简报。
  const sessions = db
    .prepare(
      `SELECT s.id, s.title, s.captured_at FROM sources s
        JOIN permissions p ON p.id = s.permission_id
        WHERE s.project_id = ? AND s.provider = 'coding_agent' AND p.status = 'active'
        ORDER BY s.captured_at DESC LIMIT 5`,
    )
    .all(projectId) as Array<{ id: string; title: string; captured_at: string | null }>;
  const sessionLines = sessions.map((s) => {
    const last = db
      .prepare(
        "SELECT text FROM segments WHERE source_id = ? AND role = 'user' ORDER BY sequence DESC LIMIT 1",
      )
      .get(s.id) as { text: string } | undefined;
    const day = (s.captured_at ?? '').slice(0, 10);
    return last ? `${s.title}（${day}）：${last.text.slice(0, 100)}` : `${s.title}（${day}）`;
  });

  const tasks = db
    .prepare(
      'SELECT goal, status FROM coding_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 5',
    )
    .all(projectId) as Array<{ goal: string; status: string }>;
  const taskLines = tasks.map(
    (t) => `${t.goal.split('\n')[0] ?? t.goal} —— ${STATUS_ZH[t.status] ?? t.status}`,
  );

  const render = (c: string[], s: string[], t: string[]): string => {
    const parts: string[] = [];
    if (c.length) parts.push('最近的提交（14 天内）：', ...c);
    if (s.length) parts.push('最近的编码代理会话：', ...s);
    if (t.length) parts.push('编码任务：', ...t);
    return parts.join('\n');
  };
  // 截断顺序：提交（最旧先截）→ 会话（最旧先截）→ 任务。
  let c = commitLines;
  let s = sessionLines;
  let t = taskLines;
  while (render(c, s, t).length > MAX_BRIEF_CHARS && c.length) c = c.slice(0, -1);
  while (render(c, s, t).length > MAX_BRIEF_CHARS && s.length) s = s.slice(0, -1);
  while (render(c, s, t).length > MAX_BRIEF_CHARS && t.length) t = t.slice(0, -1);
  return {
    block: render(c, s, t),
    counts: { commits: c.length, sessions: s.length, tasks: t.length },
  };
}
