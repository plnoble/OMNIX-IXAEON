// @vitest-environment jsdom
/**
 * K3 验收（规格 docs/委派/K3-驾驶舱页面.md，A 档）。
 *
 * 条件 1：模拟快照（attention 2、running 1、today.finishedTurns 5）→ 三个数字 2 / 1 / 5，
 *         两个列表条数对。
 * 条件 2：sources.relay.status='stale' → 顶部红色提示里写着 relay 和它的 note；
 *         全部 ok 时没有红色提示；顶部「N 分钟前更新」取各来源 readAt 里最旧的那个。
 * 条件 3：项目分组与状态切换（源码超过 300 行，按规格拆到 K3b：k3b-cockpit-projects.test.ts）。
 * 条件 4：定时器 60 秒触发一次接口调用（假时钟）；手动刷新按钮另调一次。
 * 条件 5：快照为空 → 各区显示空状态文字，没有报错。
 * 条件 6：导航第一项是「驾驶舱」，应用启动后的默认页是驾驶舱，总览仍在导航里。
 *
 * 另外补「要什么」里写了、编号条件没单列的可见内容：三类要用户处理的事变红、
 * 在跑的任务显示角色/任务号/已跑分钟数、额度暂停写「到 HH:MM」、最近动态的结果中文。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AttentionItem,
  CockpitSnapshot,
  RecentEvent,
  RunningItem,
  SourceHealth,
} from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-10-31T12:00:00+08:00');
const READ_AT = '2026-10-31T03:55:00.000Z'; // NOW 前 5 分钟

const harness = vi.hoisted(() => ({
  snapshot: null as unknown,
  calls: 0,
  failOnce: false,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getCockpitSnapshot: async () => {
      harness.calls += 1;
      if (harness.failOnce) {
        harness.failOnce = false;
        throw new Error('合成读取失败');
      }
      return harness.snapshot;
    },
    getState: async () => ({
      version: '0.2.9',
      dataDir: 'TMP',
      setupComplete: true,
      serverRunning: false,
      serverPort: 0,
      platform: 'win32',
      envOverride: true,
      dataDirSource: 'env',
    }),
    listProjects: async () => [],
    listMatchedFindings: async () => [],
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { CockpitPage } from '../../src/renderer/src/pages/Cockpit.js';
import App from '../../src/renderer/src/App.js';

let container: HTMLDivElement;
let root: Root;

const health = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  status: 'ok',
  readAt: READ_AT,
  lastEventAt: null,
  note: null,
  ...over,
});

const attention = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: 'queue_user',
  project: null,
  text: '合成要用户处理的事',
  since: null,
  ...over,
});

const running = (over: Partial<RunningItem> = {}): RunningItem => ({
  kind: 'relay',
  role: null,
  taskId: null,
  startedAt: null,
  until: null,
  text: '合成在跑的事',
  ...over,
});

const recent = (over: Partial<RecentEvent> = {}): RecentEvent => ({
  at: '2026-10-31T03:50:00.000Z',
  role: 'dev',
  taskId: 'K3',
  outcome: 'done',
  text: '第 60 棒',
  ...over,
});

const snapshot = (over: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({
  generatedAt: NOW.toISOString(),
  sources: { relay: health(), queue: health(), projects: health() },
  attention: [],
  running: [],
  projects: { active: [], paused: [], archived: [] },
  recent: [],
  today: { finishedTurns: 0 },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness.snapshot = snapshot();
  harness.calls = 0;
  harness.failOnce = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(el = createElement(CockpitPage)): Promise<void> {
  await act(async () => {
    root.render(el);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const $ = <T extends Element>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

const count = (testId: string): number =>
  container.querySelectorAll(`[data-testid="${testId}"]`).length;

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('条件 1：三个数字与两个列表', () => {
  it('attention 2、running 1、today 5 → 显示 2 / 1 / 5，两个列表各 2 条和 1 条', async () => {
    harness.snapshot = snapshot({
      attention: [
        attention({ kind: 'relay_down', text: '调度器进程不在了，锁文件残留' }),
        attention({ kind: 'queue_user', text: '要不要做 K4', project: 'IXAEON' }),
      ],
      running: [running({ kind: 'relay', text: '调度器在转（进程 123）' })],
      today: { finishedTurns: 5 },
      recent: [recent(), recent({ outcome: 'failed' }), recent({ outcome: 'quota' })],
    });
    await render();
    expect($('cockpit-count-attention')!.querySelector('strong')!.textContent).toBe('2');
    expect($('cockpit-count-attention')!.textContent).toContain('等你处理');
    expect($('cockpit-count-running')!.querySelector('strong')!.textContent).toBe('1');
    expect($('cockpit-count-running')!.textContent).toContain('正在运行');
    expect($('cockpit-count-today')!.querySelector('strong')!.textContent).toBe('5');
    expect($('cockpit-count-today')!.textContent).toContain('今天完成');
    expect(count('cockpit-attention-item')).toBe(2);
    expect(count('cockpit-running-item')).toBe(1);
    expect(count('cockpit-recent-item')).toBe(3);
  });

  it('「正在运行」只数 relay 和 turn，额度暂停中的角色不算', async () => {
    harness.snapshot = snapshot({
      running: [
        running({ kind: 'relay' }),
        running({ kind: 'turn', role: 'dev', taskId: 'K3' }),
        running({ kind: 'paused_role', role: 'dev2', until: NOW.toISOString() }),
      ],
    });
    await render();
    expect($('cockpit-count-running')!.querySelector('strong')!.textContent).toBe('2');
    expect(count('cockpit-running-item')).toBe(3);
  });
});

describe('条件 2：来源不正常的红字与更新时间', () => {
  it('relay stale → 顶部变红，提示里写着 relay 和它的 note；N 分钟前取最旧 readAt', async () => {
    harness.snapshot = snapshot({
      sources: {
        relay: health({
          status: 'stale',
          note: '最后一棒结束已超过 2 小时，队列里还有要做的，可能停了',
        }),
        queue: health({ readAt: '2026-10-31T03:57:00.000Z' }),
        projects: health({ readAt: '2026-10-31T03:59:00.000Z' }),
      },
    });
    await render();
    expect($('cockpit-updated')!.textContent).toContain('5 分钟前更新');
    const warning = $('cockpit-sources-warning')!;
    expect(warning.className).toContain('warn');
    expect(warning.textContent).toContain('relay');
    expect(warning.textContent).toContain('最后一棒结束已超过 2 小时，队列里还有要做的，可能停了');
    expect($('cockpit-updated')!.className).toContain('warn');
  });

  it('全部 ok → 没有红色提示；队列没设仓库路径 → 写「队列：没设仓库路径」', async () => {
    await render();
    expect($('cockpit-sources-warning')).toBeNull();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    harness.snapshot = snapshot({
      sources: {
        relay: health(),
        queue: health({
          status: 'missing',
          note: '没有设置 IXAEON 仓库路径（cockpit.ixaeon_repo）',
        }),
        projects: health(),
      },
    });
    await render();
    expect($('cockpit-sources-warning')!.textContent).toContain('队列：没设仓库路径');
  });
});

describe('条件 4：60 秒自动刷新与手动刷新', () => {
  it('假时钟：初始 1 次，59 秒还是 1 次，60 秒变 2 次；点刷新再多 1 次', async () => {
    await render();
    expect(harness.calls).toBe(1);
    await pass(59_000);
    expect(harness.calls).toBe(1);
    await pass(1_000);
    expect(harness.calls).toBe(2);
    await click($('cockpit-refresh'));
    expect(harness.calls).toBe(3);
  });
});

describe('条件 5：空快照', () => {
  it('各区显示空状态文字，没有报错', async () => {
    await render();
    expect($('cockpit-attention-empty')!.textContent).toContain('现在没有等你处理的事');
    expect($('cockpit-running-empty')!.textContent).toContain('现在没有在跑的任务');
    expect($('cockpit-projects-empty')!.textContent).toContain('现在没有项目');
    expect($('cockpit-recent-empty')!.textContent).toContain('还没有最近动态');
    expect($('error-banner')).toBeNull();
  });
});

describe('第一次读取失败：显示报错条，刷新按钮还能点', () => {
  it('点刷新重试成功后，驾驶舱内容出来、报错条消失', async () => {
    harness.failOnce = true;
    await render();
    expect($('error-banner')!.textContent).toContain('合成读取失败');
    expect($('cockpit-refresh')).not.toBeNull();
    await click($('cockpit-refresh'));
    expect($('error-banner')).toBeNull();
    expect($('cockpit-count-today')).not.toBeNull();
  });
});

describe('条件 6：导航第一项与默认页', () => {
  it('导航第一项是「驾驶舱」，启动后默认打开驾驶舱，总览还在导航里', async () => {
    await render(createElement(App));
    expect($('page-cockpit')).not.toBeNull();
    const nav = $('main-nav')!;
    expect(nav.firstElementChild!.textContent).toContain('驾驶舱');
    expect($('nav-cockpit')).not.toBeNull();
    expect($('nav-overview')).not.toBeNull();
  });
});

describe('「要什么」里的其它可见内容', () => {
  it('relay_down / turn_unfinished / relay_stale 变红，queue_user 不变红', async () => {
    harness.snapshot = snapshot({
      attention: [
        attention({ kind: 'relay_down', text: '调度器进程不在了' }),
        attention({ kind: 'turn_unfinished', text: '第 4 棒没有跑完' }),
        attention({ kind: 'relay_stale', text: '可能停了' }),
        attention({ kind: 'queue_user', text: '要不要做 K4' }),
      ],
    });
    await render();
    const rows = container.querySelectorAll('[data-testid="cockpit-attention-item"]');
    expect(rows.length).toBe(4);
    for (const i of [0, 1, 2]) expect(rows[i]!.className).toContain('warn');
    expect(rows[3]!.className).not.toContain('warn');
    expect(rows[0]!.textContent).toContain('调度器不在');
    expect(rows[1]!.textContent).toContain('上一棒没跑完');
    expect(rows[2]!.textContent).toContain('可能停了');
    expect(rows[3]!.textContent).toContain('等你拍板');
  });

  it('在跑的写角色、任务号和已跑分钟数；额度暂停写「额度暂停到 HH:MM」', async () => {
    const started = new Date(NOW.getTime() - 3 * 60_000).toISOString();
    const until = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 18, 30).toISOString();
    harness.snapshot = snapshot({
      running: [
        running({ kind: 'turn', role: 'dev', taskId: 'K3', startedAt: started }),
        running({ kind: 'paused_role', role: 'dev2', until }),
      ],
    });
    await render();
    const rows = container.querySelectorAll('[data-testid="cockpit-running-item"]');
    expect(rows[0]!.textContent).toContain('dev');
    expect(rows[0]!.textContent).toContain('K3');
    expect(rows[0]!.textContent).toContain('已跑 3 分钟');
    expect(rows[1]!.textContent).toContain('dev2');
    expect(rows[1]!.textContent).toContain('额度暂停到 18:30');
  });

  it('最近动态：时间、角色、任务号、结果（完成 / 失败 / 超时 / 额度 / 其他）', async () => {
    harness.snapshot = snapshot({
      recent: [
        recent({ outcome: 'done', role: 'dev', taskId: 'K3' }),
        recent({ outcome: 'failed' }),
        recent({ outcome: 'timeout' }),
        recent({ outcome: 'quota' }),
        recent({ outcome: 'other' }),
      ],
    });
    await render();
    const rows = container.querySelectorAll('[data-testid="cockpit-recent-item"]');
    expect(rows.length).toBe(5);
    for (const [i, label] of ['完成', '失败', '超时', '额度', '其他'].entries())
      expect(rows[i]!.textContent).toContain(label);
    expect(rows[0]!.textContent).toContain('K3');
    expect(rows[0]!.textContent).toContain('dev');
    const at = new Date('2026-10-31T03:50:00.000Z');
    const local = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    expect(rows[0]!.textContent).toContain(local);
  });

  it('最近动态最多 20 条', async () => {
    harness.snapshot = snapshot({
      recent: Array.from({ length: 25 }, (_, i) =>
        recent({ taskId: `T${i}`, at: new Date(NOW.getTime() - i * 60_000).toISOString() }),
      ),
    });
    await render();
    expect(container.querySelectorAll('[data-testid="cockpit-recent-item"]').length).toBe(20);
  });
});
