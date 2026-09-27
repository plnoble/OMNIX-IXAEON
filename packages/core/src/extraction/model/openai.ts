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
  /** M1：这个实例的网关不支持流式（报过 400 或明确拒绝），之后不再尝试。 */
  private streamingUnsupported = false;

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
    if (!this.streamingUnsupported) body['stream'] = true;
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
      // 只对明确拒绝 stream 的 400 回退：模型、输入、schema 的 400 照旧报错。
      if (body['stream'] === true && rejectsStream(res.status, text)) {
        this.streamingUnsupported = true;
        return this.requestViaResponses(system, user, jsonSchema, retry);
      }
      if (retry && (res.status === 429 || res.status >= 500)) {
        return this.request(system, user, jsonSchema, false);
      }
      throw new ModelError(
        `API 错误 ${res.status}: ${text.slice(0, 200)}`,
        res.status === 429 || res.status >= 500,
      );
    }
    if (!isEventStream(res)) {
      // 网关忽略 stream、回了普通 JSON：记住，之后不再尝试流式。
      if (body['stream'] === true) this.streamingUnsupported = true;
      const json = (await res.json()) as {
        output?: Array<{ content?: Array<{ text?: string }> }>;
      };
      const texts: string[] = [];
      for (const part of json.output ?? []) {
        for (const c of part.content ?? []) {
          if (typeof c.text === 'string') texts.push(c.text);
        }
      }
      if (texts.length === 0) throw new ModelError('API 返回空文本', true);
      return texts.join('\n');
    }
    return this.readOrRetry(() => readResponsesStream(res), system, user, jsonSchema, retry);
  }

  /** 响应头到手之后的读取断了，也按网络错误重试一次。 */
  private async readOrRetry(
    read: () => Promise<string>,
    system: string,
    user: string,
    jsonSchema: { name: string; schema: Record<string, unknown> } | null,
    retry: boolean,
  ): Promise<string> {
    try {
      return await read();
    } catch (err) {
      // 截断（流在完成前结束）算网络错误，和读取中途断开一样重试一次。
      const truncated = err instanceof ModelError && err.message.includes('流在完成前结束');
      if (err instanceof ModelError && !truncated) throw err;
      if (retry) return this.request(system, user, jsonSchema, false);
      throw new ModelError(`网络错误: ${String(err instanceof Error ? err.message : err)}`, true);
    }
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
    };
    // 不支持流式的网关连 stream: false 都会拒（它拒绝的是这个未知字段），所以直接不带。
    if (!this.streamingUnsupported) body['stream'] = true;
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
      if (body['stream'] === true && rejectsStream(res.status, text)) {
        this.streamingUnsupported = true;
        return this.requestViaChatCompletions(system, user, jsonSchema, retry);
      }
      if (retry && (res.status === 429 || res.status >= 500)) {
        return this.request(system, user, jsonSchema, false);
      }
      throw new ModelError(
        `API 错误 ${res.status}: ${text.slice(0, 200)}`,
        res.status === 429 || res.status >= 500,
      );
    }
    if (isEventStream(res)) {
      return this.readOrRetry(() => readChatStream(res), system, user, jsonSchema, retry);
    }
    if (body['stream'] === true) this.streamingUnsupported = true;
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
    throw new ModelError(
      `API 错误 ${res.status}: ${text.slice(0, 200)}`,
      res.status === 429 || res.status >= 500,
    );
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const models = (json.data ?? [])
    .map((m) => ({ id: String(m.id ?? '') }))
    .filter((m) => m.id.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** 结构化错误里点名 stream 的：error.param 是 stream 且错误码属于「参数被拒」类。 */
function structuredRejectsStream(text: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return false;
  }
  const root = obj as Record<string, unknown>;
  const err = (root['error'] ?? obj) as Record<string, unknown>;
  if (typeof err !== 'object' || err === null) return false;
  const param =
    typeof err['param'] === 'string'
      ? err['param']
      : typeof err['parameter'] === 'string'
        ? err['parameter']
        : null;
  if (param !== 'stream' && param !== 'streaming') return false;
  const code = `${String(err['code'] ?? '')} ${String(err['type'] ?? '')}`.toLowerCase();
  return /unsupported|unknown|not.enabled|disabled|unrecognized/.test(code);
}

/**
 * 400 里明确拒绝 stream 这个参数才算「不支持流式」。
 * 先认结构化错误（error.param），再按词判断（不按字符距离）：拆成小写单词，看 stream 紧挨着什么。
 *   命中：「unknown parameter: 'stream'」「'stream' is not supported」
 *         「stream parameter is not supported」「stream must be false」
 *         「does not support stream」「error.param="stream" + unsupported_parameter」
 *   不命中：「unsupported schema property 'stream'」「schema property stream is not supported」
 *         （拒绝的是 schema 属性）、「unsupported upstream model」（没有独立的 stream）、
 *         「stream must be a boolean」（值类型错，不是参数被拒）。
 */
function rejectsStream(status: number, text: string): boolean {
  if (status !== 400) return false;
  if (structuredRejectsStream(text)) return true;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  // 参数称谓：stream parameter / option / param …
  const PARAM = new Set([
    'parameter',
    'parameters',
    'param',
    'params',
    'option',
    'options',
    'argument',
    'arguments',
    'field',
    'fields',
    'flag',
    'flags',
  ]);
  // 单独一个词就表示「拒绝」的
  const REJECT = new Set(['unsupported', 'unknown', 'invalid', 'disabled']);
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'stream' && words[i] !== 'streaming') continue;
    // 「schema property/field stream」：拒绝的是 schema 里叫 stream 的属性，跳过这个词。
    const prev = words[i - 1] ?? '';
    const prev2 = words[i - 2] ?? '';
    if ((prev === 'property' || prev === 'field') && prev2 === 'schema') continue;
    // 向后：stream [parameter] [is] not supported / unsupported / must be false
    let j = i + 1;
    if (PARAM.has(words[j] ?? '')) j += 1;
    if (words[j] === 'is' || words[j] === 'was' || words[j] === 'are') j += 1;
    const after = words[j] ?? '';
    const afterNext = words[j + 1] ?? '';
    const afterNext2 = words[j + 2] ?? '';
    const forward =
      (after === 'not' && ['supported', 'enabled', 'allowed', 'permitted'].includes(afterNext)) ||
      after === 'unsupported' ||
      (after === 'must' &&
        afterNext === 'be' &&
        ['false', 'disabled', 'omitted', 'absent'].includes(afterNext2));
    if (forward) return true;
    // 向前：unknown [parameter] stream / not supported: stream / not support stream
    let k = i - 1;
    if (k >= 0 && PARAM.has(words[k] ?? '')) k -= 1;
    const before = k >= 0 ? (words[k] ?? '') : '';
    const beforePrev = k >= 1 ? (words[k - 1] ?? '') : '';
    const backward =
      REJECT.has(before) ||
      (before === 'support' && beforePrev === 'not') ||
      (before === 'supported' && beforePrev === 'not') ||
      (before === 'enabled' && beforePrev === 'not');
    if (backward) return true;
  }
  return false;
}

function isEventStream(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/event-stream');
}

/**
 * 流里的错误套进既有的两种前缀：限流写成「API 错误 429」、服务端类写成「API 错误 500」，
 * 队列和界面按这两个前缀认暂时性错误；其余照「API 错误 400」报，不算暂时性。
 * 只认结构化错误类别（type 与 code），绝不在消息正文里找数字。
 * type/code 可能是字符串也可能是数字（有的网关给 JSON 数字），统一转成字符串再认。
 */
function streamError(
  kind: string | number | undefined,
  code: string | number | undefined,
  message: string,
): ModelError {
  const text = message.length > 0 ? message : '流式响应失败';
  const c = `${String(kind ?? '')} ${String(code ?? '')}`.toLowerCase();
  if (/rate.?limit|429/.test(c)) return new ModelError(`API 错误 429: ${text}`, true);
  if (/server_error|overloaded|unavailable|timeout|(^|[^0-9])5\d\d([^0-9]|$)/.test(c)) {
    return new ModelError(`API 错误 500: ${text}`, true);
  }
  return new ModelError(`API 错误 400: ${String(code ?? kind ?? '')} ${text}`.trim(), false);
}

/**
 * 按 SSE 读：事件可能被拆在两次读取之间，一次读取里也可能有多个事件。
 * 事件分隔兼容 \n\n 与 \r\n\r\n；onEvent 返回 true 表示流已到头，读完即停。
 */
async function readEvents(res: Response, onEvent: (data: string) => boolean | void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split < 0) break;
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data.length > 0 && onEvent(data)) return;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** /responses 的流：累加 output_text.delta，completed 结束，failed / error 抛错。 */
async function readResponsesStream(res: Response): Promise<string> {
  let text = '';
  let finished = false;
  await readEvents(res, (data) => {
    const event = JSON.parse(data) as {
      type?: string;
      delta?: string;
      code?: string | number;
      message?: string;
      error?: { type?: string | number; code?: string | number; message?: string };
      response?: { error?: { type?: string | number; code?: string | number; message?: string } };
    };
    if (event.type === 'response.output_text.delta') {
      text += event.delta ?? '';
      return false;
    }
    if (event.type === 'response.completed') {
      finished = true;
      return true; // 到头了，停止读取
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      const err = event.error ?? event.response?.error;
      throw streamError(
        err?.type ?? event.type,
        err?.code ?? event.code,
        err?.message ?? event.message ?? '',
      );
    }
    return false;
  });
  // 没等到 completed 就断流 = 截断，不算成功；只收到 completed 没有文字 = 空文本。
  if (!finished) throw new ModelError('API 返回空文本（流在完成前结束）', true);
  if (text.length === 0) throw new ModelError('API 返回空文本', true);
  return text;
}

/** /chat/completions 的流：累加 delta.content，[DONE] 结束。 */
async function readChatStream(res: Response): Promise<string> {
  let text = '';
  let done = false;
  await readEvents(res, (data) => {
    if (data.trim() === '[DONE]') {
      done = true;
      return true; // 到头了，停止读取
    }
    const event = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>;
      error?: { type?: string | number; code?: string | number; message?: string };
    };
    if (event.error)
      throw streamError(event.error.type, event.error.code, event.error.message ?? '');
    text += event.choices?.[0]?.delta?.content ?? '';
    return false;
  });
  // 没等到 [DONE] 就断流 = 截断，不算成功。
  if (!done) throw new ModelError('API 返回空文本（流在完成前结束）', true);
  if (text.length === 0) throw new ModelError('API 返回空文本', true);
  return text;
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
