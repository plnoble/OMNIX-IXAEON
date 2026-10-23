/**
 * L9 验收测试（四）：规划棒之后的飞书与记账（规格条件 4、5，对应契约第 7、8 条）。
 *
 * 逐条对应：
 * - 加了两行、没越界 → 假飞书收到一条 `planned`，正文就是 `formatEvent` 拼出来的那段：
 *   第一行「整合方排了 2 件新活：」，之后每行一条「- 第 <no> 行 <task>（<status>）」，按主表的先后；
 * - 替身一行都没加 → 不发 planned；之后照常空转，原来的 idle 照发；
 * - planned 不限频：连着两条都发、不记限频（同一个北京日里第二条照样发得出去）；
 * - 记账那一条的 `kind` / `taskId` / `statusBefore` / `statusAfter` 照契约第 8 条。
 *
 * 合成仓库 + 本机假飞书（地址和密钥都是合成的），不调真模型、不连 GitHub。
 */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createNotifier, formatEvent } from '../../src/notify/feishu.js';
import { fakeFeishu, makeL9World, type World } from './l9-harness.js';

const worlds: World[] = [];
const closers: Array<() => Promise<void>> = [];
const world = (opts: Parameters<typeof makeL9World>[0] = {}) => {
  const w = makeL9World(opts);
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const w of worlds.splice(0)) rmSync(w.root, { recursive: true, force: true });
});

const ROWS = [
  { no: '73', task: 'L11 合成的第一件', status: '待领' },
  { no: '74', task: 'L12 合成的第二件', status: '等用户：要不要这样排' },
];

describe('条件 4 / 5：规划棒之后发什么、记什么', () => {
  it('加了两行、没越界 → 一条 planned（正文逐字）；记账照契约第 8 条', async () => {
    const fake = await fakeFeishu();
    closers.push(fake.close);
    const w = world({ planPerDay: 2, feishu: fake });
    w.writePlan({ rows: ROWS, message: '规划：排两件' });

    const r = await w.run(['once']);
    expect(r.status, r.stderr || r.stdout).toBe(0);

    const planned = fake.texts.filter((t) => t.includes('整合方排了'));
    expect(planned).toEqual([formatEvent({ kind: 'planned', rows: ROWS })]);
    expect(planned[0]!.split('\n')).toEqual([
      '【IXAEON 接力】',
      '整合方排了 2 件新活：',
      '- 第 73 行 L11 合成的第一件（待领）',
      '- 第 74 行 L12 合成的第二件（等用户：要不要这样排）',
    ]);

    const ledger = w.ledger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      role: 'integrator',
      kind: 'integrator-plan',
      taskId: 'plan',
      statusBefore: 'queue-empty',
      statusAfter: '加了 2 行',
      violations: [],
    });
  }, 120_000);

  it('替身一行都没加 → 不发 planned；之后照常空转，原来的 idle 照发', async () => {
    const fake = await fakeFeishu();
    closers.push(fake.close);
    const w = world({ planPerDay: 2, feishu: fake });
    w.writePlan({ rows: [] });

    const r = await w.run(['run', '--exit-when-idle']);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(fake.texts.some((t) => t.includes('整合方排了'))).toBe(false);
    expect(fake.texts).toContain(formatEvent({ kind: 'idle', why: 'queue-empty' }));
    const ledger = w.ledger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'integrator-plan', taskId: 'plan' });
    expect(ledger[0]!.statusAfter).toBe('加了 0 行');
  }, 120_000);

  it('planned 不限频：连着两条都发，不记进限频表', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ code: 0 }) };
    }) as unknown as typeof fetch;
    const store = { sent: {} as Record<string, string> };
    const notifier = createNotifier(
      { webhookUrl: 'http://127.0.0.1:1/nowhere', secret: 'synthetic-secret-not-real' },
      store,
      { fetch: fakeFetch, now: () => new Date('2026-10-23T02:00:00.000Z') },
    );
    const event = { kind: 'planned' as const, rows: ROWS };

    expect(await notifier.notify(event)).toEqual({ ok: true, sent: true });
    expect(await notifier.notify(event)).toEqual({ ok: true, sent: true });
    expect(calls).toBe(2);
    expect(store.sent).toEqual({});
  });
});
