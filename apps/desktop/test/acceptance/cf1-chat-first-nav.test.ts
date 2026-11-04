// @vitest-environment jsdom
/**
 * CF1 验收（规格 docs/委派/CF1-聊天做首页.md，A 档）。
 *
 * 条件 1：应用启动（没有任何保存的页面状态）→ 当前页是聊天页（page-ask），不是驾驶舱。
 * 条件 2：导航第一项的文字是「聊天」，点它打开聊天页；第二项是驾驶舱，点它打开驾驶舱页。
 * 条件 3：导航里其余各项的先后和改之前一样。
 *         改之前的顺序（BEFORE）按 K3 时的实际导航写死：[驾驶舱, 总览, 理解, 待讨论, 问答,
 *         待办, 目标, 历史, 项目, 来源, 检索, 研究, 任务, 设置]；改后应是
 *         [聊天, 驾驶舱, 总览, 理解, 待讨论, 待办, 目标, 历史, 项目, 来源, 检索, 研究, 任务, 设置]，
 *         也就是只在最前面加「聊天」、把驾驶舱挪到第二，其余相对次序一个不动。
 *
 * 本测试只看 App.tsx 的导航与默认页；页面内部、驾驶舱内容不在这一单（K3 锁定测试另跑）。
 * K3 锁定的条件 6 写死了「导航第一项是驾驶舱、默认页是驾驶舱」，按规格由整合方改，本单不改。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitSnapshot } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const READ_AT = '2026-10-31T03:55:00.000Z';

const harness = vi.hoisted(() => ({
  cockpit: null as unknown,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
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
    listConversations: async () => [],
    listTodos: async () => [],
    getCockpitSnapshot: async () => harness.cockpit,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import App from '../../src/renderer/src/App.js';

let container: HTMLDivElement;
let root: Root;

const health = () => ({
  status: 'ok' as const,
  readAt: READ_AT,
  lastEventAt: null,
  note: null,
});

const cockpit = (): CockpitSnapshot => ({
  generatedAt: READ_AT,
  sources: { relay: health(), queue: health(), projects: health() },
  attention: [],
  running: [],
  projects: { active: [], paused: [], archived: [] },
  recent: [],
  today: { finishedTurns: 0 },
});

beforeEach(() => {
  harness.cockpit = cockpit();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = <T extends Element>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderApp(): Promise<void> {
  await act(async () => {
    root.render(createElement(App));
  });
  await settle();
}

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** 导航每一项的可见文字（去掉 badge 的数字空白）。 */
function navLabels(): string[] {
  const nav = $('main-nav')!;
  return [...nav.children].map((el) => (el.textContent ?? '').trim());
}

/** 改之前的导航顺序，按 K3 时的 App.tsx 写死（条件 3 照这个比对）。 */
const BEFORE = [
  '驾驶舱',
  '总览',
  '理解',
  '待讨论',
  '问答',
  '待办',
  '目标',
  '历史',
  '项目',
  '来源',
  '检索',
  '研究',
  '任务',
  '设置',
];

describe('CF1 聊天做首页、驾驶舱放第二', () => {
  it('条件 1：应用启动（没有保存的页面状态）默认打开聊天页，不是驾驶舱', async () => {
    await renderApp();
    expect($('page-ask')).not.toBeNull();
    expect($('page-cockpit')).toBeNull();
  });

  it('条件 2：导航第一项「聊天」点开聊天页；第二项「驾驶舱」点开驾驶舱页', async () => {
    await renderApp();
    const nav = $('main-nav')!;
    const first = nav.children[0]!;
    const second = nav.children[1]!;
    expect((first.textContent ?? '').trim()).toBe('聊天');
    expect((second.textContent ?? '').trim()).toBe('驾驶舱');

    // 先离开聊天页，确认第一项真的能把人带回聊天页
    await click($('nav-cockpit'));
    expect($('page-cockpit')).not.toBeNull();
    await click(nav.children[0]!);
    expect($('page-ask')).not.toBeNull();
    expect($('page-cockpit')).toBeNull();

    // 第二项打开驾驶舱
    await click($('nav-cockpit'));
    expect($('page-cockpit')).not.toBeNull();
    expect($('page-ask')).toBeNull();
  });

  it('条件 3：其余各项的先后和改之前一样（按改之前的顺序写死比对）', async () => {
    await renderApp();
    const rest = BEFORE.filter((x) => x !== '驾驶舱' && x !== '问答');
    // MP2b 规格加了「模型」一项，放在「设置」前面（整合方复审时补）；其余先后不变
    rest.splice(rest.indexOf('设置'), 0, '模型');
    const expected = ['聊天', '驾驶舱', ...rest];
    expect(navLabels()).toEqual(expected);
    // 「问答」只改了显示名，data-testid 不变（避免连带改到别处按 nav-ask 找元素的代码）
    expect($('nav-ask')).not.toBeNull();
  });
});
