/**
 * CF3：直连聊天的引擎循环（规格「要什么」第 2、3 条）。messages 顺序：
 * system → 调用方给的上下文块 → 此前的轮次 → 这一问；工具最多 6 轮，第 7 次请求不带 tools。
 * 契约见规格「契约」一节，导出名与字段不改。
 */
import type { MemoryUsedItem } from '@ixaeon/contracts';
import type { ChatMessage, ChatToolCall, ChatToolDef, StreamChatClient } from './chatStream.js';
import type { AgentStep, PriorTurn } from './session.js';

export const DIRECT_CHAT_PROMPT_VERSION = 'd1' as const;

export const DIRECT_CHAT_TOOL_NAMES = [
  'search_memory',
  'get_evidence',
  'get_project_context',
  'search_web',
  'read_web',
] as const;

export const DIRECT_CHAT_SYSTEM_PROMPT = [
  '你是 IXAEON（析衍），用户的个人助手。开头一句直接给答案，用简洁的中文回答。',
  '',
  '问到用户本人、过去说过做过的事、用户的项目时，先调 search_memory 查 IXAEON 记忆；预先给的记忆不够就再查。',
  '问到最新的、实时的、公开的事实，或者你没把握的事，调 search_web；需要原文时调 read_web，回答里写出网页来源。',
  '资料不够就直说不够，不要编；搜索没有配置或失败时如实说明，不假装搜过。',
  '标成「AI 建议」的记忆是 AI 以前的说法，不是用户的决定；一次性的事不是长期原则；已经过去的事不要当成眼下的事。',
  '不要在回答末尾附「建议待办」，也不要主动提议建任务。',
].join('\n');

export interface DirectChatTools {
  defs: ChatToolDef[];
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string; memoryUsed?: MemoryUsedItem[] }>;
}
export interface DirectChatResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  answer: string;
  failure: string | null;
  steps: AgentStep[];
  memoryUsed: MemoryUsedItem[];
  toolsUnsupported: boolean;
}

/** 此前轮次的总字符上限（沿用 AgentSession 的既有口径），超出时丢最早的。 */
const PRIOR_CHARS_LIMIT = 6000;

function fitPriorTurns(priorTurns: PriorTurn[]): PriorTurn[] {
  let used = 0;
  let index = priorTurns.length;
  while (index > 0 && used + priorTurns[index - 1]!.content.length <= PRIOR_CHARS_LIMIT) {
    used += priorTurns[index - 1]!.content.length;
    index -= 1;
  }
  return priorTurns.slice(index);
}

/** 按 id 去重，先来的（预先注入的）优先。 */
function mergeMemory(base: MemoryUsedItem[], extra: MemoryUsedItem[]): MemoryUsedItem[] {
  const byId = new Map<string, MemoryUsedItem>();
  for (const item of [...base, ...extra]) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 只看错误的 name，不按报错文字猜：网关报错里写着 cancel 也不算取消。 */
function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

export async function runDirectChat(input: {
  client: StreamChatClient;
  question: string;
  priorTurns: PriorTurn[];
  contextBlock: string;
  preMemoryUsed: MemoryUsedItem[];
  tools: DirectChatTools;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onProgress?: (phase: 'thinking' | 'answering') => void;
  maxToolRounds?: number;
}): Promise<DirectChatResult> {
  const maxToolRounds = Math.max(1, input.maxToolRounds ?? 6);
  const messages: ChatMessage[] = [{ role: 'system', content: DIRECT_CHAT_SYSTEM_PROMPT }];
  if (input.contextBlock.trim().length > 0) {
    messages.push({ role: 'user', content: input.contextBlock });
  }
  for (const turn of fitPriorTurns(input.priorTurns)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: input.question });

  const steps: AgentStep[] = [];
  let memoryUsed = [...input.preMemoryUsed];
  let answer = '';
  let toolRounds = 0;
  let toolsUnsupported = false;
  let answering = false;
  const emit = (text: string): void => {
    answer += text;
    if (!answering) {
      answering = true;
      input.onProgress?.('answering');
    }
    input.onDelta?.(text);
  };

  try {
    for (;;) {
      if (input.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      input.onProgress?.('thinking');
      const sendTools = toolRounds < maxToolRounds ? input.tools.defs : undefined;
      const result = await input.client.stream({
        messages: [...messages],
        ...(sendTools?.length ? { tools: sendTools } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        onDelta: emit,
      });
      toolsUnsupported = toolsUnsupported || result.toolsUnsupported;
      const calls: ChatToolCall[] = result.toolCalls;

      if (calls.length === 0 || toolRounds >= maxToolRounds) {
        // 正文通常已经经 onDelta 累积；没有流式正文时用结果里的 content。
        if (result.content.length > answer.length) answer = result.content;
        // 最后一轮不给工具也没说出话：不当回答存档，记成失败（a5 条件 7）
        if (calls.length > 0 && answer.trim() === '') {
          const failure = `到了轮次上限（${maxToolRounds} 轮）还没形成回答`;
          return { status: 'failed', answer, failure, steps, memoryUsed, toolsUnsupported };
        }
        return { status: 'succeeded', answer, failure: null, steps, memoryUsed, toolsUnsupported };
      }

      // OpenAI 兼容端点要求：tool 结果前面必须有那条带 toolCalls 的 assistant 消息。
      messages.push({ role: 'assistant', content: result.content, toolCalls: calls });
      toolRounds += 1;
      for (const call of calls) {
        const args = parseArgs(call.arguments);
        let ok = false;
        let content = '';
        try {
          const outcome = await input.tools.call(call.name, args);
          ok = outcome.ok;
          content = outcome.content;
          if (outcome.memoryUsed?.length) memoryUsed = mergeMemory(memoryUsed, outcome.memoryUsed);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          content = `工具 ${call.name} 出错：${reason.slice(0, 200)}`;
        }
        steps.push({
          round: toolRounds,
          tool: call.name,
          ok,
          detail: JSON.stringify(args).slice(0, 120),
        });
        messages.push({ role: 'tool', toolCallId: call.id, content });
      }
    }
  } catch (error) {
    if (isAbort(error) || input.signal?.aborted) {
      return { status: 'cancelled', answer, failure: null, steps, memoryUsed, toolsUnsupported };
    }
    const failure = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      answer,
      failure: failure.slice(0, 120),
      steps,
      memoryUsed,
      toolsUnsupported,
    };
  }
}
