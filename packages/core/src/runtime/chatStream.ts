/** CF3 直连聊天流式客户端（规格「要什么」第 1 条）。契约导出名与字段不改。 */
import { ModelError } from '../extraction/model/provider.js';

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
export interface ChatToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ChatStreamResult {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  toolsUnsupported: boolean;
}
export interface StreamChatClient {
  readonly modelName: string;
  stream(input: {
    messages: ChatMessage[];
    tools?: ChatToolDef[];
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<ChatStreamResult>;
}
type Chunk = {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
};
/** 网关明确拒绝 tools（区别于别的 400）。 */
class ToolsRejectedError extends Error {}
const aborted = (): Error => new DOMException('已取消', 'AbortError');
/** 等 signal 触发；与 reader.read() 竞速，超时/取消都能真的把挂起的读打断。 */
function untilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(aborted());
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

export class OpenAIChatStreamClient implements StreamChatClient {
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    model: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.modelName = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async stream(input: {
    messages: ChatMessage[];
    tools?: ChatToolDef[];
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<ChatStreamResult> {
    if (input.signal?.aborted) throw aborted();
    // 不给 tools 的尝试只有 1 次；给了 tools 才可能因网关不认而重发一次。
    const attempts: (ChatToolDef[] | undefined)[] = input.tools?.length
      ? [input.tools, undefined]
      : [undefined];
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        return { ...(await this.request(input, attempts[i])), toolsUnsupported: i > 0 };
      } catch (error) {
        const last = i === attempts.length - 1;
        if (last || !(error instanceof ToolsRejectedError) || input.signal?.aborted) throw error;
      }
    }
    throw new ModelError('聊天网关请求未完成', false);
  }

  private async request(
    input: { messages: ChatMessage[]; signal?: AbortSignal; onDelta?: (t: string) => void },
    tools: ChatToolDef[] | undefined,
  ): Promise<ChatStreamResult> {
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    input.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    // 超时不是取消：只有 input.signal 被 abort 才算取消，超时按可重试的模型错误报。
    const stopError = (): Error =>
      input.signal?.aborted ? aborted() : new ModelError('聊天网关超时', true);
    try {
      const messages = input.messages.map((m) => {
        if (m.role === 'tool')
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        if (m.role !== 'assistant') return { role: m.role, content: m.content };
        const out: Record<string, unknown> = { role: 'assistant', content: m.content };
        if (m.toolCalls?.length) {
          out['tool_calls'] = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          }));
        }
        return out;
      });
      const body: Record<string, unknown> = { model: this.modelName, messages, stream: true };
      if (tools?.length) {
        body['tools'] = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 400 && /tools|function|tool_choice/i.test(text)) {
          throw new ToolsRejectedError(text.slice(0, 200));
        }
        throw new ModelError(
          `聊天网关返回 ${res.status}：${text.slice(0, 120) || '（无正文）'}`,
          res.status === 429 || res.status >= 500,
        );
      }
      return await this.readStream(res, input.onDelta ?? ((): void => undefined), ctrl);
    } catch (error) {
      throw ctrl.signal.aborted ? stopError() : error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 逐行读 SSE：正文累积并回调；工具调用按 index 拼参数（可能拆在多次读取里）。 */
  private async readStream(
    res: Response,
    onDelta: (text: string) => void,
    ctrl: AbortController,
  ): Promise<ChatStreamResult> {
    // 这里只抛 AbortError；到底是取消还是超时，由 request() 按 input.signal 判定。
    if (!res.body) throw new ModelError('聊天网关没有返回流', false);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const partial = new Map<number, ChatToolCall>();
    let buffer = '';
    let content = '';
    let finishReason: string | null = null;
    const snapshot = (): ChatStreamResult => ({
      content,
      toolCalls: [...partial.values()].filter((c) => c.name.length > 0),
      finishReason,
      toolsUnsupported: false,
    });
    for (;;) {
      if (ctrl.signal.aborted) throw aborted();
      const { done, value } = await Promise.race([reader.read(), untilAbort(ctrl.signal)]);
      if (done) return snapshot();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return snapshot();
        let parsed: Chunk;
        try {
          parsed = JSON.parse(payload) as Chunk;
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          content += choice.delta.content;
          onDelta(choice.delta.content);
        }
        for (const call of choice.delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = partial.get(index) ?? { id: '', name: '', arguments: '' };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          partial.set(index, current);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }
}

/** 测试用假客户端：按脚本一轮一轮吐正文分段或工具调用，并记下每次收到的 messages 与 tools。 */
export class FakeStreamChatClient implements StreamChatClient {
  readonly modelName: string;
  readonly calls: { messages: ChatMessage[]; tools?: ChatToolDef[] }[] = [];
  private cursor = 0;
  constructor(
    private readonly script: { deltas?: string[]; toolCalls?: ChatToolCall[]; error?: string }[],
    modelName = 'fake-direct',
    /** 测试用：每段之间等这么久，好让端到端看到「正在回答」的中间态。 */
    private readonly delayMs = 0,
  ) {
    this.modelName = modelName;
  }
  async stream(input: {
    messages: ChatMessage[];
    tools?: ChatToolDef[];
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<ChatStreamResult> {
    this.calls.push({ messages: input.messages, tools: input.tools });
    const step = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    if (!step) throw new ModelError('假客户端没有脚本', false);
    if (step.error) throw new ModelError(step.error, false);
    if (input.signal?.aborted) throw aborted();
    const deltas = step.deltas ?? [];
    for (const delta of deltas) {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      if (input.signal?.aborted) throw aborted();
      input.onDelta?.(delta);
    }
    return {
      content: deltas.join(''),
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
      toolsUnsupported: false,
    };
  }
}
