import { ErrorCodes, IxaError } from '@ixaeon/contracts';

/**
 * 本机文本向量（三周任务单 R1，用户 2026-09-17 批准使用 Ollama + qwen3-embedding:0.6b）。
 *
 * 两条硬约束：
 * 1. 只连本机地址。向量是用你的记忆原文算出来的，这条路不允许把文本送出电脑；
 *    配置成远端地址时直接拒绝，而不是悄悄发出去。
 * 2. 不下载模型。模型由用户在 Ollama 里显式拉取；这里只调用，缺模型就如实报错。
 */
export interface TextEmbedder {
  /** 模型标识，写进向量表，换模型后旧向量自动视为过期。 */
  readonly modelId: string;
  /** 文档（记忆条目）向量，已归一化。 */
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  /** 问题向量，已归一化。部分模型要求问题带检索指令，由实现负责。 */
  embedQuery(text: string): Promise<Float32Array>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** 是否本机回环地址（只允许这些地址承载记忆文本）。 */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 归一化为单位向量（此后余弦相似度 = 点积）。零向量原样返回。 */
export function normalize(vec: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vec);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i]! * out[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

/** 两个已归一化向量的余弦相似度。维度不同视为不可比（返回 0）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * Qwen3-Embedding 是「指令感知」模型：检索时问题要带任务指令，文档不带
 *（Qwen 官方用法；指令建议用英文）。其他模型不加。
 */
function queryPrefixFor(model: string): string {
  return /^qwen3-embedding/i.test(model)
    ? 'Instruct: Given a question, retrieve personal notes and memories that help answer it\nQuery: '
    : '';
}

export class OllamaEmbedder implements TextEmbedder {
  readonly modelId: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    model: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    if (!isLoopbackUrl(baseUrl)) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        `向量服务只能是本机地址（记忆文本不能经此离开电脑）：${baseUrl}`,
      );
    }
    this.modelId = `ollama:${opts.model}`;
    this.model = opts.model;
    this.baseUrl = baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.call(texts);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vec] = await this.call([`${queryPrefixFor(this.model)}${text}`]);
    return vec!;
  }

  private async call(input: string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new IxaError(
        ErrorCodes.MODEL_CALL_FAILED,
        `连不上本机向量服务（Ollama 是否在运行？）：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint = /not found/i.test(body)
        ? `本机还没有模型 ${this.model}（需在 Ollama 里先拉取）`
        : `向量服务返回 ${res.status}`;
      throw new IxaError(ErrorCodes.MODEL_CALL_FAILED, `${hint}：${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { embeddings?: number[][] };
    const embeddings = json.embeddings ?? [];
    if (embeddings.length !== input.length) {
      throw new IxaError(
        ErrorCodes.MODEL_CALL_FAILED,
        `向量服务返回数量不符：请求 ${input.length} 条，收到 ${embeddings.length} 条`,
      );
    }
    return embeddings.map((e) => normalize(e));
  }
}
