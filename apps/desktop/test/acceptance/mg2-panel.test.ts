// @vitest-environment jsdom
/**
 * MG2 验收（规格 docs/委派/MG2-角色走magpie轮动.md，B 档：本周例外，测试和实现一起在分支上）。
 *
 * 条件 1（界面这一半）：整合方、审查两行的下拉里有 magpie 的模型和分组（含「默认」），开发那行
 *          在原有选项之外也有；连不上 magpie 时只有原来的选项、旁边写「没连上 magpie」。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitSnapshot, RelayModelRow, RelayModels, SourceHealth } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  snapshot: null as unknown,
  models: null as unknown,
  calls: [] as Array<{ role: string; value: string | null }>,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getCockpitSnapshot: async () => harness.snapshot,
    getRelayModels: async () => JSON.parse(JSON.stringify(harness.models)) as RelayModels,
    setRelayModel: async (input: { role: string; value: string | null }) => {
      harness.calls.push(input);
      const models = harness.models as RelayModels;
      models.roles = models.roles.map((row) =>
        row.role === input.role ? { ...row, current: input.value } : row,
      );
      return { ok: true as const };
    },
    listProjects: async () => [],
    listMatchedFindings: async () => [],
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { CockpitPage } from '../../src/renderer/src/pages/Cockpit.js';

let container: HTMLDivElement;
let root: Root;

const health = (): SourceHealth => ({
  status: 'ok',
  readAt: '2026-11-01T00:00:00.000Z',
  lastEventAt: null,
  note: null,
});

const snapshot = (): CockpitSnapshot => ({
  generatedAt: '2026-11-01T00:00:00.000Z',
  sources: { relay: health(), queue: health(), projects: health() },
  attention: [],
  running: [],
  projects: { active: [], paused: [], archived: [] },
  recent: [],
  today: { finishedTurns: 0 },
});

const row = (over: Partial<RelayModelRow> & Pick<RelayModelRow, 'role'>): RelayModelRow => ({
  agent: over.role === 'integrator' ? 'claude' : over.role === 'reviewer' ? 'codex' : 'dsh',
  current: null,
  options: [],
  configured: true,
  note: null,
  ...over,
});

const MAGPIE = ['a/m1', 'b/m2', 'group/rot'];

const models = (reachable: boolean): RelayModels => ({
  roles: [
    row({
      role: 'developer',
      current: 'gw / model-a1',
      options: [
        'gw / model-a1',
        ...(reachable ? MAGPIE.map((id) => `magpie / ${id}`) : []),
      ],
      note: reachable ? null : '没连上 magpie',
    }),
    row({
      role: 'integrator',
      current: '默认',
      options: ['默认', 'opus', 'sonnet', 'haiku', ...(reachable ? MAGPIE : [])],
      note: reachable ? null : '没连上 magpie',
    }),
    row({
      role: 'reviewer',
      current: '跟 Codex 自己的设置',
      options: reachable ? ['默认', ...MAGPIE] : [],
      note: reachable ? null : '没连上 magpie',
    }),
    row({ role: 'reviewerSubstitute', configured: false, note: '没配' }),
    row({ role: 'integratorSubstitute', configured: false, note: '没配' }),
  ],
});

beforeEach(() => {
  harness.snapshot = snapshot();
  harness.models = models(true);
  harness.calls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(CockpitPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const $ = <T extends Element>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);
const optionValues = (select: HTMLSelectElement | null): string[] =>
  [...(select?.querySelectorAll('option') ?? [])].map((o) => (o as HTMLOptionElement).value);

describe('条件 1（界面）：magpie 的模型和分组出现在三行的下拉里', () => {
  it('整合方 / 审查 / 开发的下拉都含 a/m1、b/m2、group/rot；整合方 / 审查还有「默认」', async () => {
    await render();
    const integrator = optionValues($<HTMLSelectElement>('relay-model-select-integrator'));
    expect(integrator).toEqual(expect.arrayContaining(['默认', ...MAGPIE]));
    const reviewer = optionValues($<HTMLSelectElement>('relay-model-select-reviewer'));
    expect(reviewer).toEqual(expect.arrayContaining(['默认', ...MAGPIE]));
    const developer = optionValues($<HTMLSelectElement>('relay-model-select-developer'));
    expect(developer).toEqual(expect.arrayContaining(MAGPIE.map((id) => `magpie / ${id}`)));
    expect(container.textContent).not.toContain('没连上 magpie');
  });

  it('审查选 group/rot → 调 setRelayModel，刷新后显示新值', async () => {
    await render();
    const select = $<HTMLSelectElement>('relay-model-select-reviewer')!;
    await act(async () => {
      select.value = 'group/rot';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(harness.calls).toEqual([{ role: 'reviewer', value: 'group/rot' }]);
    expect($('relay-model-current-reviewer')!.textContent).toContain('group/rot');
  });
});

describe('条件 1（界面）：连不上 magpie', () => {
  it('只有原来的选项，三行旁边都写「没连上 magpie」', async () => {
    harness.models = models(false);
    await render();
    expect(optionValues($<HTMLSelectElement>('relay-model-select-integrator'))).toEqual([
      '默认',
      'opus',
      'sonnet',
      'haiku',
    ]);
    expect($<HTMLSelectElement>('relay-model-select-reviewer')).toBeNull();
    expect(optionValues($<HTMLSelectElement>('relay-model-select-developer'))).toEqual([
      'gw / model-a1',
    ]);
    for (const role of ['developer', 'integrator', 'reviewer']) {
      expect($(`relay-model-note-${role}`)!.textContent).toBe('没连上 magpie');
    }
  });
});