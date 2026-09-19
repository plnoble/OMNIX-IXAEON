/**
 * 派给 Hermes 的约定（措辞由整合方定，执行方不改）。
 * 2026-09-19 真机（gemini-3.7-flash-tiered）：原措辞「如果你建议用户…去做具体的事」下，
 * 解释概念、回答事实的问题也每次附 3–4 件，待办会越积越多；收紧到只在问下一步、
 * 请它安排、或明确要人去办时才列。
 */
export const SUGGESTED_TODOS_INSTRUCTION =
  '（IXAEON 约定：只在用户问接下来做什么、请你安排或规划，或者明确要用户或 IXAEON 去办某件事时，在回答最后另起一段，第一行写「建议待办：」，下面每行以「- 」开头写一件具体的事，最多 5 件。解释概念、回答事实、比较方案、给一般性建议时不写；没有就不写这一段。）';

const HEADING = /^(?:建议待办[:：])$/;
const LIST = /^(?:[-*•]\s+|\d+[.、)]\s*)(.*)$/;
const USER_PREFIXES = ['记个待办：', '加个待办：', '加待办：', '待办：', '待办:'] as const;

function isHeading(line: string): boolean {
  return HEADING.test(line.replace(/[#*\s]/g, ''));
}

function listItem(line: string): string | null {
  const m = LIST.exec(line.trimStart());
  return m ? m[1]!.trim() : null;
}

/**
 * 从回答末尾取出「建议待办」列表；没有标题行则原样返回。
 * 正文里顺口提到「建议待办」不算。
 */
export function extractSuggestedTodos(answer: string): { answer: string; todos: string[] } {
  const lines = answer.split('\n');
  let headingAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i]!)) headingAt = i;
  }
  if (headingAt < 0) return { answer, todos: [] };

  let end = headingAt + 1;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    if (line.trim() === '' || listItem(line) !== null) continue;
    break;
  }

  const seen = new Set<string>();
  const todos: string[] = [];
  for (let i = headingAt + 1; i < end && todos.length < 5; i++) {
    const raw = listItem(lines[i]!);
    if (raw === null || raw.length === 0) continue;
    const title = raw.length > 80 ? raw.slice(0, 80) : raw;
    if (seen.has(title)) continue;
    seen.add(title);
    todos.push(title);
  }

  const before = lines.slice(0, headingAt).join('\n').replace(/\s+$/, '');
  const after = lines.slice(end).join('\n').trim();
  const parts = [before, after].filter((p) => p.length > 0);
  return { answer: parts.join('\n\n'), todos };
}

/** 消息开头写「待办：…」→ 标题；其余 null。 */
export function parseUserTodo(message: string): string | null {
  const s = message.replace(/^\s+/, '');
  for (const p of USER_PREFIXES) {
    if (!s.startsWith(p)) continue;
    const rest = s.slice(p.length).trim();
    return rest.length > 0 ? rest : null;
  }
  return null;
}
