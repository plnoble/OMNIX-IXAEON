/**
 * Canonical Conversation IR（RFC-001）。
 *
 * 为什么要有这一层：`ModelProvider` 原来只有 `system: string` + `user: string`，
 * 多轮角色、推理内容、工具轮次都无处安放，换 provider 要改业务调用点。
 * 这一层是**协议无关**的：任何 provider adapter 只负责 IR ↔ 自己的协议，核心层不 import 协议类型。
 *
 * 刻意**不含**（照 DeepSeek 蒸馏的 Do Not Copy 清单）：
 * `prefix` 续写、`LatestReminder` 独立消息位、多模态 token spec、tokenizer 细节。
 */
import type { ReasoningState } from './reasoning.js';

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';

export interface CanonicalToolCall {
  /** 稳定 id：tool 结果消息用它回指。 */
  id: string;
  name: string;
  /** 参数保持原始 JSON 文本，不在这一层解析——解析失败属于 provider/校验层的事。 */
  argumentsJson: string;
}

export interface CanonicalMessage {
  role: CanonicalRole;
  text: string;
  /** 仅 assistant：推理内容的状态（见 reasoning.ts 四态）。 */
  reasoning?: ReasoningState;
  /** 仅 assistant：这次要调用的工具。 */
  toolCalls?: CanonicalToolCall[];
  /** 仅 tool：回答的是哪个 tool call。 */
  toolCallId?: string;
}

export interface CanonicalConversation {
  messages: CanonicalMessage[];
}

/** 旧接口（system+user 字符串）到 IR 的等价映射：既有的 20+ 调用点语义不变。 */
export function fromLegacyPrompt(system: string, user: string): CanonicalConversation {
  return {
    messages: [
      { role: 'system', text: system },
      { role: 'user', text: user },
    ],
  };
}
