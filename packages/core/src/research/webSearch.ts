import { ErrorCodes, IxaError } from '@ixaeon/contracts';

/**
 * 受控网页搜索执行器（B3）。
 *
 * 两个官方 API 二选一（config.webSearch.provider）：
 * - Brave Search API：GET /res/v1/web/search，X-Subscription-Token 鉴权
 * - Tavily Search API：POST /search，Bearer 鉴权（面向 AI 检索设计）
 *
 * 边界：查询先经 sanitizePublicQuery 本地脱敏（broker 层做），这里只执行。
 * 失败诚实：网络/非 2xx/额度用尽都抛 IXA0017，带上游状态与摘要，不造结果。
 * 测试注入 fetchFn；生产用全局 fetch。
 */

export type WebSearchProvider = 'brave' | 'tavily';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  provider: WebSearchProvider;
  query: string;
  hits: WebSearchHit[];
}

export interface WebSearchExecutorDeps {
  /** 测试注入用；缺省用全局 fetch */
  fetchFn?: typeof fetch;
  /** 超时毫秒数（默认 15s） */
  timeoutMs?: number;
}

export interface WebSearchExecutor {
  readonly provider: WebSearchProvider;
  search(query: string, limit?: number): Promise<WebSearchOutcome>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function brief(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 300);
}

async function httpJson(
  url: string,
  init: RequestInit,
  deps: WebSearchExecutorDeps,
): Promise<unknown> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timer = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timer);
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: controller.signal });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? `超时（${timer}ms）` : String(err);
    throw new IxaError(
      ErrorCodes.SERVER_UNAVAILABLE,
      `搜索服务不可达（${reason}）。查询未发出或未完成，不伪造结果。`,
    );
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new IxaError(
        ErrorCodes.SERVER_UNAVAILABLE,
        `搜索服务拒绝认证（HTTP ${res.status}）：Key 无效或额度用尽，请检查设置。`,
      );
    }
    if (res.status === 429) {
      throw new IxaError(
        ErrorCodes.SERVER_UNAVAILABLE,
        '搜索服务限流（HTTP 429）：额度用尽或请求过频，稍后再试。',
      );
    }
    throw new IxaError(
      ErrorCodes.SERVER_UNAVAILABLE,
      `搜索服务返回 HTTP ${res.status}：${brief(text)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IxaError(
      ErrorCodes.SERVER_UNAVAILABLE,
      `搜索服务返回了无法解析的内容：${brief(text)}`,
    );
  }
}

// --- Brave ---

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

async function braveSearch(
  apiKey: string,
  query: string,
  limit: number,
  deps: WebSearchExecutorDeps,
): Promise<WebSearchOutcome> {
  const url =
    'https://api.search.brave.com/res/v1/web/search?' +
    new URLSearchParams({ q: query, count: String(limit) }).toString();
  const json = (await httpJson(
    url,
    { method: 'GET', headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' } },
    deps,
  )) as BraveResponse;
  const results = Array.isArray(json?.web?.results) ? (json.web?.results ?? []) : [];
  const hits: WebSearchHit[] = results
    .filter((r) => typeof r.url === 'string' && typeof r.title === 'string')
    .map((r) => ({
      title: String(r.title),
      url: String(r.url),
      snippet: typeof r.description === 'string' ? r.description : '',
    }));
  return { provider: 'brave', query, hits };
}

// --- Tavily ---

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

async function tavilySearch(
  apiKey: string,
  query: string,
  limit: number,
  deps: WebSearchExecutorDeps,
): Promise<WebSearchOutcome> {
  const json = (await httpJson(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
    },
    deps,
  )) as TavilyResponse;
  const results = Array.isArray(json?.results) ? (json.results ?? []) : [];
  const hits: WebSearchHit[] = results
    .filter((r) => typeof r.url === 'string' && typeof r.title === 'string')
    .map((r) => ({
      title: String(r.title),
      url: String(r.url),
      snippet: typeof r.content === 'string' ? r.content : '',
    }));
  return { provider: 'tavily', query, hits };
}

/**
 * 创建搜索执行器。provider 是实际服务；Key 由调用方解密后传入（永不明文落盘）。
 * 未知 provider 抛参数错（配置层已用 enum 限制，这里是防线二）。
 */
export function createWebSearchExecutor(
  provider: WebSearchProvider,
  apiKey: string,
  deps: WebSearchExecutorDeps = {},
): WebSearchExecutor {
  if (!apiKey) {
    throw new IxaError(ErrorCodes.VALIDATION_FAILED, '搜索执行器需要 API Key');
  }
  if (provider === 'brave') {
    return {
      provider,
      search: (query, limit = 5) => braveSearch(apiKey, query, limit, deps),
    };
  }
  if (provider === 'tavily') {
    return {
      provider,
      search: (query, limit = 5) => tavilySearch(apiKey, query, limit, deps),
    };
  }
  throw new IxaError(ErrorCodes.VALIDATION_FAILED, `未知搜索 provider：${provider satisfies never}`);
}
