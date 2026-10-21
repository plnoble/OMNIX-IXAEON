/**
 * L3 验收测试（三）：限频与配置（规格条件 5、7，对应规格第 3 条后半与第 5 条）。
 *
 * 逐条对应：
 * - 条件 5：同一种事件（kind 加上 taskId / role / why）30 分钟内第二次不发；换一个 taskId 照发；
 *   过了 30 分钟（`now` 换成 31 分钟后）照发；`daily` 不限。限频用的那个对象是调用方给的（不是全局的）。
 * - 条件 7：`feishu.json` 不存在 → 读配置返回「没配置」（`null`），不发、不抛错。
 *
 * 假飞书是本机 http 服务（127.0.0.1 随机端口），地址与密钥都是合成的。
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNotifier,
  formatEvent,
  loadFeishuTarget,
  type RelayEvent,
} from '../../src/notify/feishu.js';

const SECRET = 'synthetic-secret-not-real';
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function startFakeFeishu() {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  );
  return { url: `http://127.0.0.1:${port}/synthetic`, bodies };
}

const paused = (role: 'integrator' | 'developer', until: string): RelayEvent => ({
  kind: 'paused',
  role,
  until,
});

describe('条件 5：同一种事件 30 分钟只发一次', () => {
  it('同一件事第二次不发；换 taskId 照发；31 分钟后照发', async () => {
    const fake = await startFakeFeishu();
    const target = { webhookUrl: fake.url, secret: SECRET };
    const store = { sent: {} as Record<string, string> };
    let now = new Date('2026-10-21T10:00:00+08:00');
    const n = createNotifier(target, store, { now: () => now });

    const e1: RelayEvent = { kind: 'needs-user', taskId: '61', task: 'Q2', status: '待领' };
    expect(await n.notify(e1)).toEqual({ ok: true, sent: true });
    expect(await n.notify(e1)).toEqual({ ok: true, sent: false });
    expect(fake.bodies).toHaveLength(1);

    // 换一个 taskId：算另一种事件，照发
    expect(await n.notify({ ...e1, taskId: '62' })).toEqual({ ok: true, sent: true });
    expect(fake.bodies).toHaveLength(2);

    // 同一种 kind 但换了 role：也算另一种事件（paused 的键里带 role）
    expect(await n.notify(paused('integrator', '2026-10-21T12:00:00+08:00'))).toEqual({
      ok: true,
      sent: true,
    });
    expect(await n.notify(paused('integrator', '2026-10-21T12:00:00+08:00'))).toEqual({
      ok: true,
      sent: false,
    });
    expect(await n.notify(paused('developer', '2026-10-21T12:00:00+08:00'))).toEqual({
      ok: true,
      sent: true,
    });
    expect(fake.bodies).toHaveLength(4);

    // 过 30 分钟：同一个 taskId 的 needs-user 又能发
    now = new Date('2026-10-21T10:31:00+08:00');
    expect(await n.notify(e1)).toEqual({ ok: true, sent: true });
    expect(fake.bodies).toHaveLength(5);
  }, 60_000);

  // 整合方补（2026-10-21）：发出去的正文就是 formatEvent 那段（规格第 4 条）
  it('发出去的正文就是 formatEvent 拼出来的那段，别的什么都不带', async () => {
    const fake = await startFakeFeishu();
    const n = createNotifier(
      { webhookUrl: fake.url, secret: SECRET },
      { sent: {} },
      { now: () => new Date('2026-10-21T10:00:00+08:00') },
    );
    const e: RelayEvent = {
      kind: 'stopped',
      reason: '开发这一棒并了 B 档',
      taskId: '59',
      task: 'L0b 补完实验',
    };
    await n.notify(e);
    const body = fake.bodies[0] as Record<string, unknown>;
    expect(body.content).toEqual({ text: formatEvent(e) });
    expect(Object.keys(body).sort()).toEqual(['content', 'msg_type', 'sign', 'timestamp']);
  }, 60_000);

  // 整合方补（2026-10-21）：没发出去不能占掉 30 分钟——不然网络抖一下，「停下来了」就半小时发不出去
  it('发失败了不算发过：下一次同一件事照发', async () => {
    let ok = false;
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        bodies.push(JSON.parse(raw || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: ok ? 0 : 19021 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const store = { sent: {} as Record<string, string> };
    const n = createNotifier({ webhookUrl: `http://127.0.0.1:${port}/x`, secret: SECRET }, store, {
      now: () => new Date('2026-10-21T10:00:00+08:00'),
    });
    const e: RelayEvent = { kind: 'idle', why: 'all-blocked' };
    const first = await n.notify(e);
    expect(first.ok).toBe(false);
    ok = true;
    expect(await n.notify(e)).toEqual({ ok: true, sent: true });
  }, 60_000);

  it('idle 按 why 分：两种 why 各发一次，各自第二次不发', async () => {
    const fake = await startFakeFeishu();
    const n = createNotifier(
      { webhookUrl: fake.url, secret: SECRET },
      { sent: {} },
      { now: () => new Date('2026-10-21T10:00:00+08:00') },
    );
    expect(await n.notify({ kind: 'idle', why: 'queue-empty' })).toEqual({ ok: true, sent: true });
    expect(await n.notify({ kind: 'idle', why: 'all-blocked' })).toEqual({ ok: true, sent: true });
    expect(await n.notify({ kind: 'idle', why: 'queue-empty' })).toEqual({ ok: true, sent: false });
    expect(fake.bodies).toHaveLength(2);
  }, 60_000);

  it('daily 不限频：同一分钟内发两条都出去', async () => {
    const fake = await startFakeFeishu();
    const n = createNotifier(
      { webhookUrl: fake.url, secret: SECRET },
      { sent: {} },
      { now: () => new Date('2026-10-21T10:00:00+08:00') },
    );
    const daily: RelayEvent = { kind: 'daily', date: '10月21日', turns: 3, done: ['L1'] };
    expect(await n.notify(daily)).toEqual({ ok: true, sent: true });
    expect(await n.notify(daily)).toEqual({ ok: true, sent: true });
    expect(fake.bodies).toHaveLength(2);
  }, 60_000);

  it('限频状态在调用方给的对象里，不是全局的：两个 notifier 各用各的都会发', async () => {
    const fake = await startFakeFeishu();
    const target = { webhookUrl: fake.url, secret: SECRET };
    const a = createNotifier(
      target,
      { sent: {} },
      { now: () => new Date('2026-10-21T10:00:00+08:00') },
    );
    const b = createNotifier(
      target,
      { sent: {} },
      { now: () => new Date('2026-10-21T10:00:00+08:00') },
    );
    const e: RelayEvent = { kind: 'idle', why: 'queue-empty' };
    expect(await a.notify(e)).toEqual({ ok: true, sent: true });
    expect(await b.notify(e)).toEqual({ ok: true, sent: true });
    expect(fake.bodies).toHaveLength(2);
  }, 60_000);
});

describe('条件 7：没配置就不发、不抛错', () => {
  it('feishu.json 不存在 → 读配置返回「没配置」（null）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixa-l3-cfg-'));
    dirs.push(dir);
    expect(loadFeishuTarget(join(dir, '没有这个文件.json'))).toBeNull();
  });

  it('feishu.json 在 → 读出地址与密钥', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixa-l3-cfg-'));
    dirs.push(dir);
    const p = join(dir, 'feishu.json');
    writeFileSync(
      p,
      `${JSON.stringify({ webhookUrl: 'http://127.0.0.1:1/synthetic', secret: SECRET })}\n`,
      'utf8',
    );
    expect(loadFeishuTarget(p)).toEqual({
      webhookUrl: 'http://127.0.0.1:1/synthetic',
      secret: SECRET,
    });
  });

  // 整合方改（2026-10-21）：原来这条不带参数直接读默认路径——会去读用户本机真的 feishu.json
  // （里面是 webhook 地址和密钥）。改成把数据目录指到临时目录再读。
  it('默认路径是数据目录里的 feishu.json（IXAEON_RELAY_DIR 指到临时目录验）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixa-l3-cfg-'));
    dirs.push(dir);
    const old = process.env.IXAEON_RELAY_DIR;
    process.env.IXAEON_RELAY_DIR = dir;
    try {
      expect(loadFeishuTarget()).toBeNull();
      writeFileSync(
        join(dir, 'feishu.json'),
        `${JSON.stringify({ webhookUrl: 'http://127.0.0.1:1/synthetic', secret: SECRET })}\n`,
        'utf8',
      );
      expect(loadFeishuTarget()).toEqual({
        webhookUrl: 'http://127.0.0.1:1/synthetic',
        secret: SECRET,
      });
    } finally {
      if (old === undefined) delete process.env.IXAEON_RELAY_DIR;
      else process.env.IXAEON_RELAY_DIR = old;
    }
  });

  it('feishu.json 坏了（不是 JSON、缺字段）→ 也当没配置（null），不抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixa-l3-cfg-'));
    dirs.push(dir);
    const p = join(dir, 'feishu.json');
    writeFileSync(p, '{ 不是 json', 'utf8');
    expect(loadFeishuTarget(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ webhookUrl: 'http://127.0.0.1:1/synthetic' }), 'utf8');
    expect(loadFeishuTarget(p)).toBeNull();
  });

  it('目标为 null（没配置）→ notify 返回 sent: false，一个请求都不发，不抛错', async () => {
    const fake = await startFakeFeishu();
    const n = createNotifier(null, { sent: {} });
    expect(await n.notify({ kind: 'idle', why: 'queue-empty' })).toEqual({ ok: true, sent: false });
    expect(fake.bodies).toHaveLength(0);
  });
});
