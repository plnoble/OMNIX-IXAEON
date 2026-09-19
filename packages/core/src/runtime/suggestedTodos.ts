/** 派给 Hermes 的约定（措辞写死，一个字不改）。 */
export const SUGGESTED_TODOS_INSTRUCTION =
  '（IXAEON 约定：如果你建议用户或 IXAEON 接下来去做具体的事，在回答最后另起一段，第一行写「建议待办：」，下面每行以「- 」开头写一件，最多 5 件；没有就不写这一段。）';

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
