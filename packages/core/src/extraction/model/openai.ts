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
    // 计划 5.3.5：Zod 校验失败最多重试一次
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.request(input.system, input.user, {
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
}

/** zod 4 → JSON Schema（strict json_schema 要求 additionalProperties: false）。 */
function zodToJsonSchema(schema: zType.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  return json;
}
