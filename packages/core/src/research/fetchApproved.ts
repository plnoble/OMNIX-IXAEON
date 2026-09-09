import { lookup } from 'node:dns/promises';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import { assertPublicHttpsUrl, isBlockedResolvedAddress } from './urlSafety.js';

export const RESEARCH_TIMEOUT_MS = 20_000;
export const RESEARCH_MAX_BYTES = 2 * 1024 * 1024;
export const RESEARCH_MAX_REDIRECTS = 3;

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

export interface FetchDeps {
  lookup?(hostname: string): Promise<Array<{ address: string; family: number }>>;
  fetch?(url: string, init: RequestInit): Promise<Response>;
  now?(): number;
}

/**
 * 批准来源抓取：HTTPS + DNS/连接地址双校验 + 重定向逐跳校验。
 * 无 Cookie、不执行脚本、不跟随 file:/私网。
 */
export async function fetchApprovedSource(
  rawUrl: string,
  deps: FetchDeps = {},
): Promise<FetchResult> {
  const dnsLookup = deps.lookup ?? ((hostname: string) => lookup(hostname, { all: true }));
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  let current = assertPublicHttpsUrl(rawUrl);
  for (let hop = 0; hop <= RESEARCH_MAX_REDIRECTS; hop++) {
    await assertResolvedPublic(current.hostname, dnsLookup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept:
            'text/html, application/xhtml+xml, application/xml, application/rss+xml, text/xml, text/plain;q=0.8',
          'User-Agent': 'IXAEON-research/0.3 (approved-source-check; no-cookies)',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new IxaError(ErrorCodes.BAD_ORIGIN, `抓取失败：${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new IxaError(ErrorCodes.BAD_ORIGIN, '重定向缺少 Location');
      if (hop === RESEARCH_MAX_REDIRECTS) {
        throw new IxaError(ErrorCodes.BAD_ORIGIN, `重定向超过 ${RESEARCH_MAX_REDIRECTS} 次`);
      }
      current = assertPublicHttpsUrl(new URL(loc, current).toString());
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new IxaError(
        ErrorCodes.PERMISSION_DENIED,
        `来源需要登录或禁止访问（HTTP ${res.status}），不绕过`,
      );
    }
    if (res.status >= 400) {
      throw new IxaError(ErrorCodes.BAD_ORIGIN, `来源返回 HTTP ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') ?? 'text/plain').toLowerCase();
    if (!isAllowedType(contentType)) {
      throw new IxaError(ErrorCodes.UNSUPPORTED_FORMAT, `拒绝的内容类型：${contentType}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > RESEARCH_MAX_BYTES) {
      throw new IxaError(ErrorCodes.PAYLOAD_TOO_LARGE, `响应超过 ${RESEARCH_MAX_BYTES} 字节`);
    }
    return {
      finalUrl: current.toString(),
      status: res.status,
      contentType,
      body: buf.toString('utf8'),
    };
  }
  throw new IxaError(ErrorCodes.BAD_ORIGIN, '重定向循环');
}

async function assertResolvedPublic(
  hostname: string,
  dnsLookup: NonNullable<FetchDeps['lookup']>,
): Promise<void> {
  if (isBlockedResolvedAddress(hostname)) {
    throw new IxaError(ErrorCodes.BAD_ORIGIN, `拒绝解析到受限地址：${hostname}`);
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(hostname);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new IxaError(ErrorCodes.BAD_ORIGIN, `DNS 解析失败：${hostname}（${msg}）`);
  }
  if (records.length === 0) {
    throw new IxaError(ErrorCodes.BAD_ORIGIN, `DNS 无记录：${hostname}`);
  }
  for (const rec of records) {
    if (isBlockedResolvedAddress(rec.address)) {
      throw new IxaError(ErrorCodes.BAD_ORIGIN, `DNS 解析到受限地址 ${rec.address}（${hostname}）`);
    }
  }
}

function isAllowedType(contentType: string): boolean {
  return (
    contentType.includes('text/') ||
    contentType.includes('xml') ||
    contentType.includes('json') ||
    contentType.includes('html')
  );
}
