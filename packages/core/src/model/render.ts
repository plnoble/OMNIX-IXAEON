/**
 * DS3（保守方案）：把 Canonical IR 渲染成**现有** ModelProvider 能吃的输入。
 * 统筹 2026-10-27 任务书 §8：第一阶段不改 `ModelProvider` 公共接口、
 * 不迁移既有测试、不扩大 Provider Contract——多轮语义先经这层纯函数落地。
 *
 * 两条硬规矩：
 * 1. **先全量校验、后一次产出**：任何坏结构（严格档缺 reasoning、孤儿 tool 结果）
 *    都在产出之前抛错——不给调用方半截渲染结果去发给模型；
 * 2. **provider 中立**：这里不出现任何 provider 专有词；协议转换是各家 adapter 的事。
 */
import type { CanonicalConversation, CanonicalMessage } from './canonical.js';
import { renderReasoningFor, type ReasoningRules } from './reasoning.js';

export interface RenderedMessage {
  role: CanonicalMessage['role'];
  text: string;
  /** 渲染后的推理文本；'' = 本轮无内容可传（含合法空与非 thinking 丢弃）。 */
  reasoning: string;
  toolCallId?: string;
  toolCalls?: CanonicalMessage['toolCalls'];
}

export interface RenderedConversation {
  messages: RenderedMessage[];
}

const DEFAULT_RULES: ReasoningRules = { thinking: false, strict: false };

/**
 * 渲染一段会话。`rules` 缺省为非 thinking、非严格（宽松）。
 * 抛错都带**消息序号**，让调用方能定位是哪一轮坏了。
 */
export function renderConversation(
  conversation: CanonicalConversation,
  rules: ReasoningRules = DEFAULT_RULES,
): RenderedConversation {
  const messages = conversation.messages;

  // 第一段：只校验。tool 结果必须能回指到某条 assistant 声明过的 call。
  const declaredCallIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) declaredCallIds.add(call.id);
  }
  messages.forEach((message, index) => {
    const at = `第 ${index + 1} 条`;
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error(`${at} tool 消息缺少 toolCallId`);
      if (!declaredCallIds.has(message.toolCallId)) {
        throw new Error(
          `${at} tool 消息引用的 call 不存在：${message.toolCallId}（没有 assistant 声明过它）`,
        );
      }
    }
  });

  // 第二段：产出。reasoning 按四态渲染，严格档缺失在这一步抛出（同样先于任何返回）。
  const rendered: RenderedMessage[] = [];
  messages.forEach((message, index) => {
    let reasoning = '';
    if (message.reasoning) {
      const result = renderReasoningFor(message.reasoning, rules);
      if (!result.ok) {
        throw new Error(`第 ${index + 1} 条消息的 reasoning 无法发送：${result.message}`);
      }
      reasoning = result.text;
    }
    rendered.push({
      role: message.role,
      text: message.text,
      reasoning,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
    });
  });

  return { messages: rendered };
}

/** 一条渲染后消息 → 带角色标记的 transcript 行。 */
function transcriptLine(message: RenderedMessage): string {
  const parts: string[] = [`[${message.role}] ${message.text}`];
  if (message.reasoning) parts.push(`[reasoning] ${message.reasoning}`);
  for (const call of message.toolCalls ?? []) {
    parts.push(`[tool_call ${call.id}] ${call.name} ${call.argumentsJson}`);
  }
  if (message.role === 'tool' && message.toolCallId) {
    parts.push(`[tool_result_for ${message.toolCallId}]`);
  }
  return parts.join('\n');
}

/**
 * 把多轮压成现有接口形态：system 消息进 `system`，其余按顺序进 `user` 的 transcript。
 * **只给现有 `chatText({system, user})` 用**——provider 若要保真多轮，
 * 应由各自 adapter 读 `renderConversation` 的结果自己转，不在核心里改接口。
 */
export function toProviderPrompt(rendered: RenderedConversation): {
  system: string;
  user: string;
} {
  const system = rendered.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.text)
    .join('\n\n');
  const turns = rendered.messages.filter((m) => m.role !== 'system').map(transcriptLine);
  return { system, user: turns.join('\n') };
}
