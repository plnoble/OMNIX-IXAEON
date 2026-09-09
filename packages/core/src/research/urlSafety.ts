import { isIP } from 'node:net';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.',
  'metadata.google.internal',
  'metadata.google.internal.',
]);

/** 研究抓取只允许公开 HTTPS、443 端口。 */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IxaError(ErrorCodes.VALIDATION_FAILED, `不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new IxaError(ErrorCodes.BAD_ORIGIN, `研究只允许 HTTPS，拒绝 ${url.protocol}`);
  }
  if (url.port && url.port !== '443') {
    throw new IxaError(ErrorCodes.BAD_ORIGIN, `研究只允许 443 端口，拒绝 :${url.port}`);
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new IxaError(ErrorCodes.BAD_ORIGIN, `拒绝本机/元数据主机：${host}`);
  }
  if (isBlockedIpLiteral(host)) {
    throw new IxaError(ErrorCodes.BAD_ORIGIN, `拒绝私网/回环/链路本地/元数据地址：${host}`);
  }
  return url;
}

export function isBlockedIpLiteral(host: string): boolean {
  const ip = unwrapIpv6Literal(host);
  const ver = isIP(ip);
  if (ver === 0) return false;
  if (ver === 4) return isBlockedV4(ip);
  return isBlockedV6(ip);
}

export function isBlockedResolvedAddress(address: string): boolean {
  return isBlockedIpLiteral(address);
}

function unwrapIpv6Literal(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === '::' || n === '::1') return true;
  if (n.startsWith('fe80:') || n.startsWith('fec0:') || n.startsWith('fc') || n.startsWith('fd')) {
    return true;
  }
  if (n.startsWith('ff')) return true;
  // IPv4-mapped
  const mapped = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  return false;
}
