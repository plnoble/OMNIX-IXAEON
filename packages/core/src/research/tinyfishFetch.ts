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
const MAX_RENDER_BYTES = 2 * 1024 * 1024;

async function readLimitedResponseText(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const cl = res.headers?.get?.('content-length');
  if (cl && Number(cl) > maxBytes) {
    controller.abort();
    throw new IxaError(
      ErrorCodes.VALIDATION_FAILED,
      `TinyFish 动态抓取响应超过 ${maxBytes} 字节限制`,
    );
  }
  if (
    res.body &&
    typeof (res.body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> }).getReader ===
      'function'
  ) {
    const reader = (
      res.body as { getReader(): ReadableStreamDefaultReader<Uint8Array> }
    ).getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let chunks = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
      if (total > maxBytes) {
        await reader.cancel();
        controller.abort();
        throw new IxaError(
          ErrorCodes.VALIDATION_FAILED,
          `TinyFish 动态抓取响应超过 ${maxBytes} 字节限制`,
        );
      }
      if (value) chunks += decoder.decode(value, { stream: true });
    }
    chunks += decoder.decode();
    return chunks;
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new IxaError(
      ErrorCodes.VALIDATION_FAILED,
      `TinyFish 动态抓取响应超过 ${maxBytes} 字节限制`,
    );
  }
  return text;
}

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

      let text = '';
      let res: Response;
      try {
        res = await fetchFn('https://api.fetch.tinyfish.ai/', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'X-API-Key': apiKey,
            authorization: `Bearer ${apiKey}`,
            accept: 'application/json',
          },
          body: JSON.stringify({
            urls: [valid.toString()],
            format: 'markdown',
          }),
        });
        text = await readLimitedResponseText(res, MAX_RENDER_BYTES, controller);
      } catch (err) {
        if (err instanceof IxaError) {
          throw err;
        }
        const reason =
          (err instanceof Error && err.name === 'AbortError') || controller.signal.aborted
            ? `超时（${timer}ms）`
            : String(err);
        throw new IxaError(
          ErrorCodes.SERVER_UNAVAILABLE,
          `TinyFish 动态抓取服务不可达（${reason}）。未完成动态渲染，不伪造正文。`,
        );
      } finally {
        clearTimeout(timeout);
      }
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
        const json = JSON.parse(text) as {
          results?: Array<{
            url?: string;
            final_url?: string;
            title?: string;
            text?: string;
            content?: string;
            markdown?: string;
            status?: number;
          }>;
          errors?: Array<{
            url?: string;
            error?: string;
            status?: number;
            message?: string;
          }>;
          data?: Record<string, unknown>;
          content?: string;
          markdown?: string;
          text?: string;
          title?: string;
          status?: number;
        };

        // Q03 / T05：处理官方逐 URL 错误
        const targetStr = valid.toString();
        const urlError =
          json.errors?.find((e) => e.url === targetStr || e.url === targetUrl) ??
          (Array.isArray(json.errors) && json.errors.length > 0 ? json.errors[0] : null);
        if (urlError) {
          throw new IxaError(
            ErrorCodes.SERVER_UNAVAILABLE,
            `TinyFish 动态抓取失败（目标 ${urlError.url ?? targetUrl} 报错: ${urlError.error ?? urlError.message ?? 'error'}，HTTP ${urlError.status ?? 400}）`,
          );
        }

        // Q03 / T04：优先从 results 数组读取
        const resultItem =
          json.results?.find((r) => r.url === targetStr || r.url === targetUrl) ??
          json.results?.[0];

        const data =
          json && typeof json.data === 'object' && json.data !== null
            ? (json.data as Record<string, unknown>)
            : json;

        const content =
          resultItem?.text ??
          resultItem?.content ??
          resultItem?.markdown ??
          (typeof data?.content === 'string'
            ? data.content
            : typeof data?.markdown === 'string'
              ? data.markdown
              : typeof data?.text === 'string'
                ? data.text
                : '');

        const title =
          resultItem?.title ??
          (typeof data?.title === 'string'
            ? data.title
            : typeof json?.title === 'string'
              ? String(json.title)
              : '');

        const status =
          typeof resultItem?.status === 'number'
            ? resultItem.status
            : typeof data?.status === 'number'
              ? (data.status as number)
              : res.status;

        if (!content && json.errors && json.errors.length > 0) {
          throw new IxaError(
            ErrorCodes.SERVER_UNAVAILABLE,
            `TinyFish 动态抓取返回错误: ${JSON.stringify(json.errors)}`,
          );
        }

        if (!content || !content.trim()) {
          throw new IxaError(
            ErrorCodes.SERVER_UNAVAILABLE,
            'TinyFish 动态抓取未取得有效正文内容（结果为空或未能提取到正文）',
          );
        }

        return {
          title,
          content,
          status,
        };
      } catch (err) {
        if (err instanceof IxaError) throw err;
        throw new IxaError(
          ErrorCodes.SERVER_UNAVAILABLE,
          `TinyFish 动态抓取返回了无法解析的响应：${brief(text)}`,
        );
      }
    },
  };
}
