/**
 * L3 验收测试（二）：签名与发送（规格条件 2、3、4、6，对应规格第 3、4 条）。
 *
 * 逐条对应：
 * - 条件 2：假服务收到的请求体里，`timestamp` 是秒数字符串；`sign` 等于测试里照规格独立算出来的值；
 *   `msg_type`、`content.text` 对。
 * - 条件 3：假服务回 `{"code":0}` → `{ ok: true }`，只发了一次。
 * - 条件 4：前两次 HTTP 500 / `{"code":19021}`、第三次 `code 0` → 成功、一共 3 次；三次都失败 → `{ ok: false }`、
 *   一共 3 次、没有抛错；连不上（端口没人听）→ `{ ok: false }`、没有抛错。规格说两次重试「隔 2 秒、再隔 5 秒」，
 *   这里顺带量一下总用时（≥ 7 秒）确认真的等了。
 * - 条件 6：请求体里除了 `timestamp` / `sign` / `msg_type` / `content` 没有别的；日志与返回的错误文字里
 *   不含 webhook 地址和密钥。
 *
 * 假飞书就是本机起的 http 服务（127.0.0.1 随机端口），不连真的飞书；地址与密钥都是合成的。
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { sendFeishu } from '../../src/notify/feishu.js';

interface Recorded {
  body: Record<string, unknown>;
  headers: IncomingMessage['headers'];
}

interface Fake {
  url: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

/** 假飞书：按 replies 依次回；最后一个回复会一直用。 */
async function startFakeFeishu(replies: Array<{ status?: number; json: unknown }>): Promise<Fake> {
  const requests: Recorded[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
        headers: req.headers,
      });
      const reply = replies[Math.min(n, replies.length - 1)]!;
      n += 1;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/open-apis/bot/v2/hook/synthetic-hook`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

const SECRET = 'synthetic-secret-not-real';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('条件 2：签名照规格算', () => {
  it('timestamp 是秒数字符串；sign = Base64(HMAC-SHA256(key=timestamp\\n secret, msg=空))；其余字段对', async () => {
    const fake = await startFakeFeishu([{ json: { code: 0, msg: 'success' } }]);
    cleanups.push(fake.close);
    const before = Math.floor(Date.now() / 1000);
    const r = await sendFeishu('【IXAEON 接力】测试', { webhookUrl: fake.url, secret: SECRET });
    const after = Math.floor(Date.now() / 1000);

    expect(r).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0]!.body;
    const timestamp = body.timestamp as string;
    expect(typeof timestamp).toBe('string');
    expect(timestamp).toMatch(/^\d+$/);
    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(timestamp)).toBeLessThanOrEqual(after + 1);

    const expected = createHmac('sha256', `${timestamp}\n${SECRET}`).update('').digest('base64');
    expect(body.sign).toBe(expected);
    expect(body.msg_type).toBe('text');
    expect(body.content).toEqual({ text: '【IXAEON 接力】测试' });
    expect(fake.requests[0]!.headers['content-type']).toContain('application/json');
  });
});

describe('条件 3 / 4：成功、重试、失败都不抛错', () => {
  it('回 code 0 → 成功，只发一次', async () => {
    const fake = await startFakeFeishu([{ json: { code: 0 } }]);
    cleanups.push(fake.close);
    expect(await sendFeishu('一', { webhookUrl: fake.url, secret: SECRET })).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(1);
  });

  it('前两次失败（HTTP 500、code 19021）、第三次成功 → 成功，一共 3 次，中间真的等了', async () => {
    const fake = await startFakeFeishu([
      { status: 500, json: { code: 19021 } },
      { json: { code: 19021, msg: 'invalid signature' } },
      { json: { code: 0 } },
    ]);
    cleanups.push(fake.close);
    const t0 = Date.now();
    const r = await sendFeishu('二', { webhookUrl: fake.url, secret: SECRET });
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(3);
    // 规格：隔 2 秒、再隔 5 秒
    expect(elapsed).toBeGreaterThanOrEqual(6_000);
  }, 60_000);

  // 整合方补（2026-10-21）：HTTP 不是 2xx 就算失败，哪怕回的正文是 code 0；回的正文里没有 code 也算失败、不抛错
  it('HTTP 502 + code 0、HTTP 200 + 正文里没有 code → 都算失败要重试；第三次成功', async () => {
    const fake = await startFakeFeishu([
      { status: 502, json: { code: 0 } },
      { json: '<html>网关错误</html>' },
      { json: { code: 0 } },
    ]);
    cleanups.push(fake.close);
    const r = await sendFeishu('二点五', { webhookUrl: fake.url, secret: SECRET });
    expect(r).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(3);
  }, 60_000);

  it('三次都失败 → { ok: false }、一共 3 次、没有抛错', async () => {
    const fake = await startFakeFeishu([{ json: { code: 19021, msg: 'invalid signature' } }]);
    cleanups.push(fake.close);
    const r = await sendFeishu('三', { webhookUrl: fake.url, secret: SECRET });
    expect(r.ok).toBe(false);
    expect(fake.requests).toHaveLength(3);
  }, 60_000);

  it('连不上（端口没人听）→ { ok: false }、没有抛错', async () => {
    const fake = await startFakeFeishu([{ json: { code: 0 } }]);
    const url = fake.url;
    await fake.close();
    const r = await sendFeishu('四', { webhookUrl: url, secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(typeof r.error).toBe('string');
      // 整合方补（2026-10-21）：连不上时的错误文字也不许带地址（网络错误的原文里常带着目标地址）
      expect(r.error).not.toContain(url);
      expect(r.error).not.toContain('synthetic-hook');
      expect(r.error).not.toContain(SECRET);
    }
  }, 60_000);
});

describe('条件 6：不外发别的、日志和错误里不带地址与密钥', () => {
  it('请求体只有那四个字段，content 里只有 text', async () => {
    const fake = await startFakeFeishu([{ json: { code: 0 } }]);
    cleanups.push(fake.close);
    await sendFeishu('五', { webhookUrl: fake.url, secret: SECRET });
    const body = fake.requests[0]!.body;
    expect(Object.keys(body).sort()).toEqual(['content', 'msg_type', 'sign', 'timestamp']);
    expect(Object.keys(body.content as Record<string, unknown>)).toEqual(['text']);
  });

  it('失败时返回的错误文字和控制台输出里都没有 webhook 地址与密钥', async () => {
    const fake = await startFakeFeishu([{ json: { code: 19021, msg: 'invalid signature' } }]);
    cleanups.push(fake.close);
    const logged: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
    console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
    let r: Awaited<ReturnType<typeof sendFeishu>>;
    try {
      r = await sendFeishu('六', { webhookUrl: fake.url, secret: SECRET });
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
    expect(r.ok).toBe(false);
    const text = `${logged.join('\n')}\n${r.ok ? '' : r.error}`;
    expect(text).not.toContain(fake.url);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('synthetic-hook');
  }, 60_000);
});
