/**
 * MP3：按候选串换下一个（聊天与后台分析共用同一套判定）。
 *
 * 「什么算不行」只写在这里：
 * - 连不上或超时（没有 status、retriable 为真）；401/403；402/429；5xx → 换下一个；
 * - 用户取消、其他 4xx、已经流出过正文之后才出错 → 不换。
 */
import { ModelError } from '@ixaeon/core';
import type { ModelProvider, StreamChatClient } from '@ixaeon/core';

/** 聊天：一个候选（解析出来的一家用哪个模型、怎么建客户端）。 */
export interface ChatCandidate {
  key: string;
  providerName: string;
  model: string;
  launch: { model: string; baseUrl: string; apiKey: string };
}

/** 后台分析：一个候选。 */
export interface ProviderCandidate {
  key: string;
  providerName: string;
  model: string;
}

export function acceptableFallback(err: unknown): boolean {
  if (!(err instanceof ModelError)) return false;
  const status = err.status;
  if (status === undefined) return err.retriable === true;
  return status === 401 || status === 403 || status === 402 || status === 429 || status >= 500;
}

export function reasonText(err: unknown): string {
  const status = err instanceof ModelError ? err.status : undefined;
  if (status === undefined) return '连不上或超时';
  if (status === 401 || status === 403) return 'Key 不对或没权限';
  if (status === 402 || status === 429) return '额度用完';
  if (status >= 500) return '服务出错';
  return '连不上或超时';
}

/**
 * 聊天用：按候选串依次建客户端。换过之后这一问后面几轮都用换上的那个，不回头。
 * 这一问已经流出过字就不换（不把半句话接别人的）。
 */
export class FallbackChatClient implements StreamChatClient {
  modelName: string;
  /** 这次是替补答的时写那句提示；没换过是 null。 */
  notice: string | null = null;
  private index = 0;
  private readonly clients = new Map<number, StreamChatClient>();
  private streamed = false;
  private firstFailure: { providerName: string; model: string; reason: string } | null = null;
  private readonly failures: Array<{ providerName: string; model: string; reason: string }> = [];

  constructor(
    private readonly candidates: ChatCandidate[],
    private readonly factory: (launch: ChatCandidate['launch']) => StreamChatClient,
    private readonly onDemote?: (key: string) => void,
  ) {
    this.modelName = candidates[0]?.model ?? '';
  }

  private clientAt(i: number): StreamChatClient {
    const cached = this.clients.get(i);
    if (cached) return cached;
    const made = this.factory(this.candidates[i]!.launch);
    this.clients.set(i, made);
    return made;
  }

  async stream(input: {
    messages: never[];
    tools?: never[];
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<Awaited<ReturnType<StreamChatClient['stream']>>> {
    const start = this.index;
    let lastError: unknown = null;
    for (let i = start; i < this.candidates.length; i += 1) {
      const candidate = this.candidates[i]!;
      const client = this.clientAt(i);
      this.streamed = false;
      const wrapped = {
        ...input,
        onDelta: (text: string): void => {
          this.streamed = true;
          input.onDelta?.(text);
        },
      };
      try {
        const result = await client.stream(wrapped as never);
        this.index = i;
        this.modelName = candidate.model;
        if (i > start && this.firstFailure) {
          const f = this.firstFailure;
          this.notice = `「${f.providerName} · ${f.model}」这次不行（${f.reason}），由替补「${candidate.providerName} · ${candidate.model}」回答`;
        }
        return result;
      } catch (err) {
        lastError = err;
        if (this.streamed || !acceptableFallback(err)) throw err;
        const failure = {
          providerName: candidate.providerName,
          model: candidate.model,
          reason: reasonText(err),
        };
        if (!this.firstFailure) this.firstFailure = failure;
        this.failures.push(failure);
        this.onDemote?.(candidate.key);
      }
    }
    const tried = this.failures
      .map((f) => `「${f.providerName} · ${f.model}」：${f.reason}`)
      .join('；');
    if (tried) throw new ModelError(`试过的候选：${tried}`, true);
    throw lastError ?? new Error('没有可用的候选');
  }
}

/** 后台分析用：两个以上候选时包一层，chatStructured / chatText 都走候选串。 */
export class FallbackModelProvider implements ModelProvider {
  modelName: string;
  private index = 0;
  private readonly providers = new Map<number, ModelProvider>();

  constructor(
    private readonly candidates: ProviderCandidate[],
    private readonly factory: (candidate: ProviderCandidate) => ModelProvider,
    private readonly log: (entry: { from: string; to: string; reason: string }) => void,
    private readonly onDemote?: (key: string) => void,
  ) {
    this.modelName = candidates[0]?.model ?? '';
  }

  private providerAt(i: number): ModelProvider {
    const cached = this.providers.get(i);
    if (cached) return cached;
    const made = this.factory(this.candidates[i]!);
    this.providers.set(i, made);
    return made;
  }

  private async run<T>(fn: (provider: ModelProvider) => Promise<T>): Promise<T> {
    const start = this.index;
    let lastError: unknown = null;
    let firstFailure: { label: string; reason: string } | null = null;
    for (let i = start; i < this.candidates.length; i += 1) {
      const candidate = this.candidates[i]!;
      try {
        const result = await fn(this.providerAt(i));
        this.index = i;
        this.modelName = candidate.model;
        if (i > start && firstFailure) {
          this.log({
            from: firstFailure.label,
            to: `${candidate.providerName} · ${candidate.model}`,
            reason: firstFailure.reason,
          });
        }
        return result;
      } catch (err) {
        lastError = err;
        if (!acceptableFallback(err)) throw err;
        if (!firstFailure) {
          firstFailure = {
            label: `${candidate.providerName} · ${candidate.model}`,
            reason: reasonText(err),
          };
        }
        this.onDemote?.(candidate.key);
      }
    }
    throw lastError ?? new Error('没有可用的候选');
  }

  chatStructured<T>(input: Parameters<ModelProvider['chatStructured']>[0]): Promise<T> {
    return this.run((p) => p.chatStructured<T>(input as never));
  }

  chatText(input: Parameters<ModelProvider['chatText']>[0]): Promise<string> {
    return this.run((p) => p.chatText(input));
  }
}
