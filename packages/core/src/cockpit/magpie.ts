/**
 * MG2：本机 magpie 的模型清单（规格 docs/委派/MG2-角色走magpie轮动.md）。
 * 只认「http + 本机主机 + 端口」，只取 `GET /v1/models` 里每个模型的 `id`（分组也在这个清单里，
 * id 写成 `group/<名字>`）；超时 3 秒，不跟跳转。不读 magpie 的配置、数据库、登录信息。
 * 地址沿用 SUB1 的 `cockpit.magpie_url`，没有就用本机默认 `http://127.0.0.1:3425`。
 */
import type { CoreDatabase } from '../db/database.js';
import { getSetting } from '../settings.js';

export const MAGPIE_URL_SETTING = 'cockpit.magpie_url';
export const DEFAULT_MAGPIE_URL = 'http://127.0.0.1:3425';
/** magpie 的 Key 就是字面量（不是密钥，公开写在文档里）。 */
export const MAGPIE_KEY = 'magpie';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** 只接受「http + 本机主机 + 端口」，不许带路径、查询、片段、用户名密码。 */
export function checkMagpieUrl(raw: string): { base?: string; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { reason: 'magpie 地址不是合法网址' };
  }
  if (url.protocol !== 'http:') return { reason: 'magpie 地址只认 http://' };
  if (!LOCAL_HOSTS.has(url.hostname)) return { reason: 'magpie 地址只认本机' };
  if (!url.port) return { reason: 'magpie 地址要写端口' };
  if (url.username || url.password) return { reason: 'magpie 地址不能带用户名密码' };
  if (url.pathname !== '/' || url.search || url.hash)
    return { reason: 'magpie 地址不能带路径、查询或片段' };
  return { base: `http://${url.hostname}:${url.port}` };
}

/** 设置里的 `cockpit.magpie_url`；没有 / 读不到就用默认，地址不合法时不给 base。 */
export function magpieUrlFromSettings(db: CoreDatabase | undefined): {
  base: string | null;
  reason: string | null;
} {
  let raw = DEFAULT_MAGPIE_URL;
  try {
    const value = db ? getSetting(db, MAGPIE_URL_SETTING)?.value.trim() : '';
    if (value) raw = value;
  } catch {
    /* 设置读不到（迁移之前）就按默认 */
  }
  const checked = checkMagpieUrl(raw);
  return checked.base
    ? { base: checked.base, reason: null }
    : { base: null, reason: '没连上 magpie' };
}

/** 读 magpie 的模型 / 分组清单；连不上、回的不是清单、超时都记「没连上 magpie」。 */
export async function listMagpieModels(
  base: string,
): Promise<{ models: string[]; error: string | null }> {
  const checked = checkMagpieUrl(base);
  if (!checked.base) return { models: [], error: '没连上 magpie' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  timer.unref?.();
  try {
    const res = await fetch(`${checked.base}/v1/models`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${MAGPIE_KEY}` },
      // 不跟跳转：本机服务回一个 30x 指到外网，跟过去就是一次外发。
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return { models: [], error: '没连上 magpie' };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { models: [], error: '没连上 magpie' };
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return { models: [], error: '没连上 magpie' };
    const models = data
      .map((item) => (item as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());
    return { models: [...new Set(models)], error: null };
  } catch {
    return { models: [], error: '没连上 magpie' };
  } finally {
    clearTimeout(timer);
  }
}
