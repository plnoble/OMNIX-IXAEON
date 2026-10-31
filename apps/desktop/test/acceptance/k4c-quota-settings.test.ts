// @vitest-environment jsdom
/**
 * K4c 界面测试（设置页的额度来源；实现阶段补的，B 档新测试，等整合方锁定）。
 *
 * 规格「要什么 / 手动登记」：设置页能填 QuotaHub 地址（空串 = 关闭），手动登记
 * 账号显示名、窗口名、下次重置、订阅到期、备注，用 `setSetting` 存进
 * `cockpit.manual_quotas`；核心层的 schema 校验读得回来。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-10-31T12:00:00+08:00');
const state = vi.hoisted(() => ({
  view: null as unknown,
  saved: [] as Array<{ quotahubUrl?: string; manualQuotas?: unknown[] }>,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getSettings: async () => state.view,
    saveCockpitSettings: async (input: { quotahubUrl?: string; manualQuotas?: unknown[] }) => {
      state.saved.push(input);
      return { ok: true as const };
    },
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { QuotaSettingsCard } from '../../src/renderer/src/pages/QuotaSettings.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.saved = [];
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
    root.render(createElement(QuotaSettingsCard));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function view(over: { quotahubUrl?: string; manualQuotas?: unknown[] } = {}): SettingsView {
  return {
    cockpit: { ixaeonRepo: '', quotahubUrl: '', manualQuotas: [], ...over },
  } as unknown as SettingsView;
}

async function fill(id: string, value: string): Promise<void> {
  await act(async () => {
    const input = $<HTMLInputElement>(id)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('K4 设置页的额度来源', () => {
  it('读回已保存的地址与手动条目', async () => {
    state.view = view({
      quotahubUrl: 'http://127.0.0.1:8787',
      manualQuotas: [
        {
          account: 'Claude 合成',
          window: '每周',
          resetAt: '2026-11-02T00:00:00.000Z',
          expiresAt: null,
          registeredAt: '2026-10-29T12:00:00.000Z',
        },
      ],
    });
    await render();

    expect($<HTMLInputElement>('settings-quotahub-url')!.value).toBe('http://127.0.0.1:8787');
    expect($$('settings-manual-quota')).toHaveLength(1);
    expect(container.textContent).toContain('Claude 合成');
  });

  it('保存地址 → 传 quotahubUrl（只写这一个键）', async () => {
    state.view = view();
    await render();
    await fill('settings-quotahub-url', 'http://localhost:8787');
    await act(async () => {
      $<HTMLButtonElement>('settings-quotahub-save')!.click();
    });
    expect(state.saved).toEqual([{ quotahubUrl: 'http://localhost:8787' }]);
  });

  it('登记一条手动额度 → manualQuotas 里多一项，带登记时刻与窗口名', async () => {
    state.view = view();
    await render();
    await fill('settings-manual-account', 'Claude 合成');
    await fill('settings-manual-reset', '2026-11-01T10:00');
    await fill('settings-manual-expires', '2026-11-30');
    await fill('settings-manual-note', '合成备注');
    await act(async () => {
      $<HTMLButtonElement>('settings-manual-add')!.click();
    });

    expect(state.saved).toHaveLength(1);
    const list = state.saved[0]!.manualQuotas as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      account: 'Claude 合成',
      window: '5 小时',
      note: '合成备注',
      registeredAt: NOW.toISOString(),
    });
    expect(typeof list[0]!.resetAt).toBe('string');
    expect(typeof list[0]!.expiresAt).toBe('string');
  });

  it('窗口选「其他」时用填的窗口名；账号为空不保存', async () => {
    state.view = view();
    await render();
    await act(async () => {
      const select = $<HTMLSelectElement>('settings-manual-window')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, '其他');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await fill('settings-manual-account', '合成');
    await fill('settings-manual-window-other', '按天');
    await act(async () => {
      $<HTMLButtonElement>('settings-manual-add')!.click();
    });
    expect(state.saved[0]!.manualQuotas).toMatchObject([{ account: '合成', window: '按天' }]);
  });

  it('删掉一条 → 保存剩下的', async () => {
    state.view = view({
      manualQuotas: [
        {
          account: 'A',
          window: '每周',
          registeredAt: '2026-10-29T12:00:00.000Z',
        },
        {
          account: 'B',
          window: '5 小时',
          registeredAt: '2026-10-30T12:00:00.000Z',
        },
      ],
    });
    await render();
    await act(async () => {
      $<HTMLButtonElement>('settings-manual-remove-0')!.click();
    });
    expect(state.saved[0]!.manualQuotas).toMatchObject([{ account: 'B' }]);
  });
});
