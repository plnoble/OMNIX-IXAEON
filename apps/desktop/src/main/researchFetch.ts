import { net } from 'electron';
import { createTinyFishFetcher, type FetchDeps, type TinyFishFetcher } from '@ixaeon/core';

/**
 * 研究抓取走 Chromium 网络栈（系统代理 / fake-ip TUN），
 * 不走 Node undici：本机 Clash 等把 DNS 指到 198.18.0.0/15 时，
 * Node 直连 TLS 会 ECONNRESET，PowerShell/浏览器却能打开。
 */
export function desktopResearchFetchDeps(
  getTinyFishFetcher?: () => TinyFishFetcher | undefined,
): FetchDeps {
  return {
    fetch: async (url, init) => {
      return net.fetch(url, {
        method: init.method ?? 'GET',
        headers: headersToRecord(init.headers),
        redirect: 'manual',
        signal: init.signal,
      });
    },
    get tinyfishFetcher() {
      return getTinyFishFetcher?.();
    },
  };
}

export function createDesktopTinyFishFetcher(apiKey: string): TinyFishFetcher {
  return createTinyFishFetcher(apiKey, {
    fetchFn: async (url, init = {}) => {
      const targetUrl = typeof url === 'string' ? url : url.toString();
      return net.fetch(targetUrl, {
        method: init.method ?? 'POST',
        headers: headersToRecord(init.headers),
        ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
        signal: init.signal,
      });
    },
  });
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}
