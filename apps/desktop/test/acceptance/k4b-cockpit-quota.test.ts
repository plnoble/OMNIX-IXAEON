// @vitest-environment jsdom
/**
 * K4b 界面测试（实现阶段补的；B 档新测试，等整合方锁定）。
 *
 * 规格「整合方审测试时的改正与补充」提醒的页面细节：
 * - 额度区：QuotaHub 的 `collected_at` 超过 15 分钟标黄「数据旧了」；
 * - 手动条目标「手动 · 登记于 N 天前」，重置时间已过提示「可能已重置，请更新」；
 * - 同一账号登记了多个窗口时合成一张卡；
 * - 项目卡片一行「最后提交 N 天前 · 7 天 M 次」，没授权写「未授权读取」。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitSnapshot, QuotaCard } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-10-31T12:00:00+08:00');
const state = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: { getCockpitSnapshot: async () => state.snapshot },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { CockpitPage } from '../../src/renderer/src/pages/Cockpit.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
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

const snap = (over: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({
  generatedAt: NOW.toISOString(),
  sources: { relay: health(), queue: health(), projects: health() },
  attention: [],
  running: [],
  projects: { active: [], paused: [], archived: [] },
  recent: [],
  today: { finishedTurns: 0 },
  ...over,
});

const card = (over: Partial<QuotaCard>): QuotaCard => ({
  source: 'quotahub',
  provider: 'codex',
  account: '合成账号',
  status: 'ok',
  plan: 'Plus',
  expiresAt: null,
  windows: [{ name: '5 小时', usedPercent: 40, resetAt: '2026-10-31T05:00:00.000Z' }],
  collectedAt: '2026-10-31T03:55:00.000Z',
  ...over,
});

describe('K4 驾驶舱额度区与项目活动', () => {
  it('QuotaHub 的收集时间超过 15 分钟 → 数据旧了；用量条与倒计时都在', async () => {
    state.snapshot = snap({ quotas: [card({ collectedAt: '2026-10-31T03:00:00.000Z' })] });
    await render();

    expect($('cockpit-quotas')).toBeTruthy();
    expect($$('cockpit-quota-card')).toHaveLength(1);
    expect(container.textContent).toContain('数据旧了');
    expect(container.textContent).toContain('已用 40%');
    expect(container.textContent).toContain('重置');
  });

  it('手动条目：登记于 N 天前；重置时间已过 → 可能已重置；同账号两个窗口合成一张卡', async () => {
    const manual = (window: string, resetAt: string): QuotaCard =>
      card({
        source: 'manual',
        provider: 'manual',
        status: 'manual',
        plan: null,
        account: 'Claude 合成',
        collectedAt: '2026-10-29T04:00:00.000Z',
        windows: [{ name: window, usedPercent: null, resetAt }],
      });
    state.snapshot = snap({
      quotas: [
        manual('5 小时', '2026-10-30T00:00:00.000Z'),
        manual('每周', '2026-11-02T00:00:00.000Z'),
      ],
    });
    await render();

    expect($$('cockpit-quota-card')).toHaveLength(1);
    expect($$('cockpit-quota-window')).toHaveLength(2);
    expect(container.textContent).toContain('手动 · 登记于 2 天前');
    expect(container.textContent).toContain('可能已重置，请更新');
  });

  it('项目卡片：有活动写「7 天 M 次」；没授权写「未授权读取」', async () => {
    const base = {
      status: 'active',
      description: null,
      currentState: null,
      updatedAt: NOW.toISOString(),
    };
    state.snapshot = snap({
      projects: {
        active: [
          {
            ...base,
            id: 'p1',
            name: '合成可读',
            activity: { lastCommitAt: '2026-10-30T04:00:00.000Z', commits7d: 3, readable: true },
          },
          {
            ...base,
            id: 'p2',
            name: '合成未授权',
            activity: { lastCommitAt: null, commits7d: null, readable: false },
          },
        ],
        paused: [],
        archived: [],
      },
    });
    await render();

    expect($('cockpit-project-activity-p1')!.textContent).toContain('最后提交 1 天前');
    expect($('cockpit-project-activity-p1')!.textContent).toContain('7 天 3 次');
    expect($('cockpit-project-activity-p2')!.textContent).toBe('未授权读取');
  });

  it('没配 QuotaHub、也没手动条目 → 空状态，不报错', async () => {
    state.snapshot = snap({
      sources: {
        ...snap().sources,
        quotas: health({ status: 'missing', note: '未连接 QuotaHub' }),
      },
    });
    await render();
    expect($('cockpit-quota-note')!.textContent).toContain('未连接 QuotaHub');
    expect($('cockpit-quotas-empty')).toBeTruthy();
  });
});
