import { z, type z as zType } from 'zod';
import { ModelError, type ModelProvider } from './provider.js';

/**
 * OpenAI Responses API 适配器。
 * - API Key 由调用方传入（桌面端经 safeStorage 解密）
 * - 结构化输出用 response_format json_schema（strict）
 * - 失败重试：网络错误 1 次；结构化校验失败 1 次（计划 5.3 第 5 条）
 * - 提取模型无 Shell、文件写入、网络搜索或工具权限（不带 tools 字段）
 */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** 端点能力探测缓存：null=未探测；true=仅 /chat/completions */
  private useChatCompletions: boolean | null = null;

  constructor(opts: {
    apiKey: string;
    modelName: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.modelName = opts.modelName;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async chatStructured<T>(input: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
  }): Promise<T> {
    // 计划 5.3.5：Zod 校验失败最多重试一次。
    // json_object 模式（/chat/completions 端点）没有 schema 强约束——
    // DeepSeek 等服务只认提示里的结构描述；把 JSON Schema 附加到 system
    // 尾部，两个端点统一生效（/responses 端点同时有 json_schema strict，
    // 双保险不冲突）。
    const schemaHint = buildSchemaHint(zodToJsonSchema(input.schema));
    const systemWithSchema = input.system + '\n\n' + schemaHint;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.request(systemWithSchema, input.user, {
        name: 'extraction',
        schema: zodToJsonSchema(input.schema),
      });
      let parsed: unknown;
      try {
        const jsonStart = raw.indexOf('{');
        const jsonEnd = raw.lastIndexOf('}');
        if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('返回中不含 JSON 对象');
        parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      } catch (err) {
        lastError = err;
        continue;
      }
      const result = input.schema.safeParse(parsed);
      if (result.success) return result.data;
      lastError = new ModelError(`结构校验失败: ${result.error.message}`, false);
    }
    throw new ModelError(`模型结构化输出两次校验失败（${String(lastError)}）`, false);
  }

  async chatText(input: { system: string; user: string }): Promise<string> {
    return this.request(input.system, input.user, null);
  }

  private async request(
    system: string,
    user: string,
    jsonSchema: { name: string; schema: Record<string, unknown> } | null,
    retry = true,
  ): Promise<string> {
    // DeepSeek 等 OpenAI 兼容服务只有 /chat/completions（无 /responses 端点）。
    // 探测结果按进程缓存：404/501 或明确「不支持」的 400 → 切换并记住。
    if (this.useChatCompletions === null) {
      this.useChatCompletions = await this.probeChatCompletions();
    }
    return this.useChatCompletions
      ? this.requestViaChatCompletions(system, user, jsonSchema, retry)
      : this.requestViaResponses(system, user, jsonSchema, retry);
  }

  /**
   * 探测上游是否只支持 /chat/completions：
   * 先发一个最小 /responses 请求 —— 404/501，或 OpenAI 兼容网关常见的
   * 「unknown url / not found」类 400 → 判定为 chat-completions-only。
   * 网络错误按官方端点处理（保持既有重试语义）。
   */
  private async probeChatCompletions(): Promise<boolean> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.modelName, input: [], store: false }),
      });
    } catch {
      return false; // 网络错误：按 /responses 路径走（其重试/报错语义不变）
    }
    if (res.status === 404 || res.status === 501) return true;
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      const t = text.toLowerCase();
      if (t.includes('not found') || t.includes('unknown url') || t.includes('invalid url')) {
        return true;
      }
    }
    return false;
  }

  /** OpenAI Responses API 路径（官方与兼容实现）。 */
  private async requestViaResponses(
    system: string,
    user: string,
    jsonSchema: { name: string; schema: Record<string, unknown> } | null,
    retry: boolean,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      store: false,
    };
    if (jsonSchema) {
      body['text'] = {
        format: {
          type: 'json_schema',
          name: jsonSchema.name,
          strict: true,
          schema: jsonSchema.schema,
        },
      };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (retry) return this.request(system, user, jsonSchema, false);
      throw new ModelError(`网络错误: ${String(err)}`, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (retry && (res.status === 429 || res.status >= 500)) {
        return this.request(system, user, jsonSchema, false);
      }
      throw new ModelError(`API 错误 ${res.status}: ${text.slice(0, 200)}`, res.status >= 500);
    }
    const json = (await res.json()) as { output?: Array<{ content?: Array<{ text?: string }> }> };
    const texts: string[] = [];
    for (const part of json.output ?? []) {
      for (const c of part.content ?? []) {
        if (typeof c.text === 'string') texts.push(c.text);
      }
    }
    if (texts.length === 0) throw new ModelError('API 返回空文本', true);
    return texts.join('\n');
  }

  /** /chat/completions 路径（DeepSeek 等 OpenAI 兼容服务）。 */
  private async requestViaChatCompletions(
    system: string,
    user: string,
    jsonSchema: { name: string; schema: Record<string, unknown> } | null,
    retry: boolean,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
    };
    if (jsonSchema) {
      // DeepSeek 的 json_object 模式：提示词内嵌 schema 说明，输出要求 JSON
      body['response_format'] = { type: 'json_object' };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (retry) return this.request(system, user, jsonSchema, false);
      throw new ModelError(`网络错误: ${String(err)}`, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (retry && (res.status === 429 || res.status >= 500)) {
        return this.request(system, user, jsonSchema, false);
      }
      throw new ModelError(`API 错误 ${res.status}: ${text.slice(0, 200)}`, res.status >= 500);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new ModelError('API 返回空文本', true);
    return text;
  }
}

/**
 * 拉取上游可用模型列表（OpenAI 兼容 GET /models）。
 * 供设置向导「获取可用模型」使用；不落盘、不缓存 Key。
 */
export async function listUpstreamModels(opts: {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<Array<{ id: string }>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.apiBaseUrl.trim() || 'https://api.openai.com/v1').replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${opts.apiKey}` },
    });
  } catch (err) {
    throw new ModelError(`网络错误: ${String(err)}`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ModelError(`API 错误 ${res.status}: ${text.slice(0, 200)}`, res.status >= 500);
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const models = (json.data ?? [])
    .map((m) => ({ id: String(m.id ?? '') }))
    .filter((m) => m.id.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** zod 4 → JSON Schema（strict json_schema 要求 additionalProperties: false）。 */
function zodToJsonSchema(schema: zType.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  return json;
}

/**
 * 把 JSON Schema 转成给模型看的输出结构说明（chat-completions 的
 * json_object 模式没有原生 schema 约束，必须在提示中给出结构）。
 * 只保留类型/必填/枚举等对生成有用的骨架，剔除 $schema 等噪音。
 */
function buildSchemaHint(jsonSchema: Record<string, unknown>): string {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$schema' || k === 'additionalProperties' || k === 'description') continue;
        out[k] = clean(v);
      }
      return out;
    }
    return node;
  };
  const cleaned = clean(jsonSchema);
  return [
    '输出格式（必须严格遵守）：',
    '只输出一个 JSON 对象，不要输出任何其他文字、注释或代码块标记。',
    '结构定义如下：',
    JSON.stringify(cleaned, null, 1),
  ].join('\n');
}
