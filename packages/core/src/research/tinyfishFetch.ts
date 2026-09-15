import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { assertPublicHttpsUrl } from './urlSafety.js';

export interface TinyFishFetchResult {
  title: string;
  content: string;
  status: number;
}

export interface TinyFishFetchDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface TinyFishFetcher {
  fetchRendered(targetUrl: string): Promise<TinyFishFetchResult>;
}

const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

function brief(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * 检查 HTML 纯文本是否属于典型的 SPA 动态渲染骨架或阻断页面。
 * 当静态抓取正文过短但含有 SPA 挂载标记时，表明需要动态渲染。
 */
export function isSpaOrDynamicSkeleton(rawHtml: string, extractedExcerpt: string): boolean {
  const textLength = extractedExcerpt.trim().length;
  // 正文若已经足够丰富（> 150 字符），视为已有有效静态正文，不触发动态渲染
  if (textLength > 150) return false;

  const lower = rawHtml.toLowerCase();
  const spaMarkers = [
    '<div id="root"',
    '<div id="app"',
    '<div id="__next"',
    '<div id="__nuxt"',
    'id="main-app"',
    '<noscript',
    'you need to enable javascript',
    'javascript is required',
    'please enable javascript',
    'checking your browser',
    'just a moment...',
  ];

  return spaMarkers.some((marker) => lower.includes(marker));
}

/**
 * 创建 TinyFish 动态网页抓取器（B3 增强）。
 * 使用云端 Web Agent 渲染无头浏览器并提取结构化正文/Markdown。
 */
export function createTinyFishFetcher(
  apiKey: string,
  deps: TinyFishFetchDeps = {},
): TinyFishFetcher {
  if (!apiKey) {
    throw new IxaError(ErrorCodes.VALIDATION_FAILED, 'TinyFish 抓取器需要 API Key');
  }

  return {
    async fetchRendered(targetUrl: string): Promise<TinyFishFetchResult> {
      // 保证目标必须是公开 HTTPS 地址
      const valid = assertPublicHttpsUrl(targetUrl);
      const fetchFn = deps.fetchFn ?? fetch;
      const timer = deps.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timer);

      let res: Response;
      try {
        res = await fetchFn('https://api.tinyfish.ai/v1/fetch', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            accept: 'application/json',
          },
          body: JSON.stringify({
            url: valid.toString(),
            format: 'markdown',
          }),
        });
      } catch (err) {
        const reason =
          err instanceof Error && err.name === 'AbortError' ? `超时（${timer}ms）` : String(err);
        throw new IxaError(
          ErrorCodes.SERVER_UNAVAILABLE,
          `TinyFish 动态抓取服务不可达（${reason}）。未完成动态渲染，不伪造正文。`,
        );
      } finally {
        clearTimeout(timeout);
      }

      const text = await res.text();
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new IxaError(
            ErrorCodes.SERVER_UNAVAILABLE,
            `TinyFish 动态抓取认证失败（HTTP ${res.status}）：Key 无效或额度用尽。`,
          );
        }
        if (res.status === 429) {
          throw new IxaError(
            ErrorCodes.SERVER_UNAVAILABLE,
            'TinyFish 动态抓取服务限流（HTTP 429）：额度用尽或请求过频。',
          );
        }
        throw new IxaError(
          ErrorCodes.SERVER_UNAVAILABLE,
          `TinyFish 动态抓取返回 HTTP ${res.status}：${brief(text)}`,
        );
      }

      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        const data =
          json && typeof json.data === 'object' && json.data !== null
            ? (json.data as Record<string, unknown>)
            : json;

        const content =
          typeof data?.content === 'string'
            ? data.content
            : typeof data?.markdown === 'string'
              ? data.markdown
              : typeof data?.text === 'string'
                ? data.text
                : '';

        const title =
          typeof data?.title === 'string'
            ? data.title
            : typeof json?.title === 'string'
              ? String(json.title)
              : '';

        const status = typeof data?.status === 'number' ? data.status : res.status;

        return {
          title,
          content,
          status,
        };
      } catch {
        throw new IxaError(
          ErrorCodes.SERVER_UNAVAILABLE,
          `TinyFish 动态抓取返回了无法解析的响应：${brief(text)}`,
        );
      }
    },
  };
}
