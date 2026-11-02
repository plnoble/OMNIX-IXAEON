// @vitest-environment jsdom
/**
 * SUB1b 验收（界面：驾驶舱额度区；规格 docs/委派/SUB1-直接接magpie.md 条件 4、7）。
 *
 * 条件 4 的界面段：magpie 卡的窗口 `display` 原样显示，快照里的卡能出现。
 * 条件 7 的界面段：点「刷新」→ 调 `refreshMagpieQuotas`，再重读快照；30 秒限流在主进程
 * （sub1b-magpie-quotas.test.ts 条件 7 覆盖），界面只管按一次调一次。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitSnapshot, QuotaCard } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-11-01T12:00:00+08:00');
const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  snapshots: 0,
  refreshes: 0,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getCockpitSnapshot: async () => {
      state.snapshots += 1;
      return state.snapshot;
    },
    refreshMagpieQuotas: async () => {
      state.refreshes += 1;
      return { ok: true as const };
    },
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { CockpitPage } from '../../src/renderer/src/pages/Cockpit.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.snapshots = 0;
  state.refreshes = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
const $$ = (id: string) => [...container.querySelectorAll(`[data-testid="${id}"]`)];

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(CockpitPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const health = (over: Partial<CockpitSnapshot['sources']['relay']> = {}) => ({
  status: 'ok' as const,
  readAt: NOW.toISOString(),
  lastEventAt: null,
  note: null,
  ...over,
});

const card = (over: Partial<QuotaCard> = {}): QuotaCard => ({
  source: 'magpie',
  provider: 'prov-a',
  account: '合成卡一',
  status: 'ok',
  plan: 'Pro',
  expiresAt: null,
  windows: [
    {
      name: '5 小时',
      usedPercent: 42.5,
      resetAt: '2026-11-01T07:00:00.000Z',
      display: '42.5 / 100 credits',
    },
  ],
  collectedAt: NOW.toISOString(),
  ...over,
});

const snap = (over: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({
  generatedAt: NOW.toISOString(),
  sources: { relay: health(), queue: health(), projects: health(), quotas: health() },
  attention: [],
  running: [],
  projects: { active: [], paused: [], archived: [] },
  recent: [],
  today: { finishedTurns: 0 },
  quotas: [],
  ...over,
});

describe('SUB1b 驾驶舱额度区（magpie）', () => {
  it('条件 4 界面段：magpie 卡的窗口 display 原样显示，用量与重置照旧', async () => {
    state.snapshot = snap({ quotas: [card()] });
    await render();

    expect($$('cockpit-quota-card')).toHaveLength(1);
    expect(container.textContent).toContain('合成卡一');
    expect(container.textContent).toContain('已用 42.5%');
    expect($('cockpit-quota-display')!.textContent).toBe('42.5 / 100 credits');
    expect(container.textContent).toContain('重置');
  });

  it('条件 5 界面段：没连上 magpie 的 note 照实显示，不报错', async () => {
    state.snapshot = snap({
      sources: {
        ...snap().sources,
        quotas: health({ status: 'missing', note: '没连上 magpie' }),
      },
    });
    await render();
    expect($('cockpit-quota-note')!.textContent).toContain('没连上 magpie');
    expect($('cockpit-quotas-empty')).toBeTruthy();
  });

  it('条件 7 界面段：点「刷新」→ 调 refreshMagpieQuotas，然后重读快照', async () => {
    state.snapshot = snap({ quotas: [card()] });
    await render();
    expect(state.snapshots).toBe(1);

    await act(async () => {
      $<HTMLButtonElement>('cockpit-quota-refresh')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(state.refreshes).toBe(1);
    expect(state.snapshots).toBe(2);
  });
});
