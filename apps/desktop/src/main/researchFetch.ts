import { net } from 'electron';
import type { FetchDeps } from '@ixaeon/core';

/**
 * 研究抓取走 Chromium 网络栈（系统代理 / fake-ip TUN），
 * 不走 Node undici：本机 Clash 等把 DNS 指到 198.18.0.0/15 时，
 * Node 直连 TLS 会 ECONNRESET，PowerShell/浏览器却能打开。
 */
export function desktopResearchFetchDeps(): FetchDeps {
  return {
    fetch: async (url, init) => {
      return net.fetch(url, {
        method: init.method ?? 'GET',
        headers: headersToRecord(init.headers),
        redirect: 'manual',
        signal: init.signal,
      });
    },
  };
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
