/** 认得真命令行的输出（L2 契约第 1 条）：Claude 是一整块 JSON、DSH 是 JSONL，`RELAY-DONE` 不在行首。 */
import type { Usage } from './types.js';

export interface RoleOutput {
  doneLine: string | null;
  usage?: Usage;
}

/** 一段文字里所有 RELAY-DONE 行（交代要的是最后一行）。 */
const doneLines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('RELAY-DONE'));

/** 用量照 L1 第 7 条：`total_cost_usd` 取到的那一个，`usage` 的 token 数加总。 */
function usageOf(stdout: string): Usage | undefined {
  const u: Usage = {};
  for (const line of stdout.split('\n')) {
    try {
      const j = JSON.parse(line) as {
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (typeof j.total_cost_usd === 'number') u.costUsd = j.total_cost_usd;
      const add = (n: number | undefined, f: 'inputTokens' | 'outputTokens') => {
        if (typeof n === 'number') u[f] = (u[f] ?? 0) + n;
      };
      add(j.usage?.input_tokens, 'inputTokens');
      add(j.usage?.output_tokens, 'outputTokens');
    } catch {
      /* 不是 JSON 的行不算 */
    }
  }
  return Object.keys(u).length ? u : undefined;
}

/**
 * 按出现次序收集 RELAY-DONE，取最后一个：
 * - 整行是 JSON 且 `result` 是字符串（Claude `--output-format json`）→ 在 result 里按行找；
 * - 整行是 JSON 且 `type` 为 `final`、`text` 是字符串（DSH `--json`）→ 在 text 里按行找；
 * - 其余按普通文字找。
 */
export function parseRoleOutput(stdout: string): RoleOutput {
  const found: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line) as { result?: unknown; type?: unknown; text?: unknown };
        // 整合方改（2026-10-24）：只认 Claude 那一整行（type 是 result）；DSH 的 tool_result 也有 result 字段
        if (j.type === 'result' && typeof j.result === 'string') found.push(...doneLines(j.result));
        else if (j.type === 'final' && typeof j.text === 'string') found.push(...doneLines(j.text));
        continue;
      } catch {
        /* 不是 JSON 就当普通文字 */
      }
    }
    if (line.startsWith('RELAY-DONE')) found.push(line);
  }
  return { doneLine: found.length ? found[found.length - 1]! : null, usage: usageOf(stdout) };
}
