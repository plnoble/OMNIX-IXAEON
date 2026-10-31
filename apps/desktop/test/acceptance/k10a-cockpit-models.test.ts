// @vitest-environment jsdom
/**
 * K10a 验收（规格 docs/委派/K10a-调度器面板.md，B 档：本周例外，测试和实现一起在分支上）。
 *
 * 条件 7：卡片四行（规格表格里 5 个角色：开发 / 整合 / 审查 / 替补审查 / 替补整合方；没配替补时
 *          替补两行显示「没配」）→ 界面上有 5 条角色行，替补两行都是「没配」；开发下拉框按网关
 *          分成 3 组、共 5 个选项；选了开发的新组合 → 调用 setRelayModel、刷新后显示新值、
 *          每行都写着「下一棒生效」。
 * 条件 8：「现在在跑」：快照里有一棒在跑（开发，第 42 棒，任务 K10a，12 分钟）→ 显示棒号、任务、
 *          分钟数、开发当前的模型。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CockpitSnapshot,
  RelayModelRow,
  RelayModels,
  RunningItem,
  SourceHealth,
} from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-10-31T12:00:00+08:00');
const READ_AT = '2026-10-31T03:55:00.000Z';

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
  readAt: READ_AT,
  lastEventAt: null,
  note: null,
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

const row = (over: Partial<RelayModelRow> & Pick<RelayModelRow, 'role'>): RelayModelRow => ({
  agent: over.role === 'integrator' ? 'claude' : over.role === 'reviewer' ? 'codex' : 'dsh',
  current: null,
  options: [],
  configured: false,
  note: null,
  ...over,
});

const models = (over: Partial<RelayModels> = {}): RelayModels => ({
  roles: [
    row({
      role: 'developer',
      current: 'baidu / deepseek-v4.1-flash-1017',
      options: [
        'baidu / deepseek-v4.1-flash-1017',
        'gw-b / model-b1',
        'gw-b / model-b2',
        'magpie / local-a',
        'magpie / local-b',
      ],
      configured: true,
    }),
    row({
      role: 'integrator',
      current: '默认',
      options: ['默认', 'opus', 'sonnet', 'haiku'],
      configured: true,
    }),
    row({ role: 'reviewer', current: '跟 Codex 自己的设置', configured: true }),
    row({ role: 'reviewerSubstitute', note: '没配' }),
    row({ role: 'integratorSubstitute', note: '没配' }),
  ],
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness.snapshot = snapshot();
  harness.models = models();
  harness.calls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
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

describe('条件 7：调度器与模型卡片、替补没配、选了新组合就写回', () => {
  it('卡片四行（开发 / 整合 / 审查 / 替补），5 个角色都有；替补两行「没配」；开发 5 个选项按 3 个网关分组；每行「下一棒生效」', async () => {
    await render();
    expect($('cockpit-relay-models')).not.toBeNull();
    // 规格表格最后一行「替补审查 / 替补整合方」是同一行，下面再分两行。
    expect($('relay-model-list')!.children).toHaveLength(4);
    for (const role of [
      'developer',
      'integrator',
      'reviewer',
      'reviewerSubstitute',
      'integratorSubstitute',
    ]) {
      expect($(`relay-model-row-${role}`), `缺少角色行 ${role}`).not.toBeNull();
    }
    expect($('relay-model-current-reviewerSubstitute')!.textContent).toBe('没配');
    expect($('relay-model-current-integratorSubstitute')!.textContent).toBe('没配');

    const select = $<HTMLSelectElement>('relay-model-select-developer');
    expect(select).not.toBeNull();
    expect(select!.querySelectorAll('option')).toHaveLength(5);
    expect(select!.querySelectorAll('optgroup')).toHaveLength(3);

    expect(container.textContent!.match(/下一棒生效/g)).toHaveLength(5);
  });

  it('选 magpie / local-a → setRelayModel、刷新后显示新值', async () => {
    await render();
    const select = $<HTMLSelectElement>('relay-model-select-developer')!;
    await act(async () => {
      select.value = 'magpie / local-a';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(harness.calls).toEqual([{ role: 'developer', value: 'magpie / local-a' }]);
    expect($('relay-model-current-developer')!.textContent).toContain('magpie / local-a');
  });
});

describe('条件 8：「现在在跑」一行', () => {
  it('快照里开发在跑 → 显示第 42 棒、开发、K10a、12 分钟、开发当前的模型', async () => {
    const running: RunningItem = {
      kind: 'turn',
      role: 'developer',
      taskId: 'K10a',
      startedAt: '2026-10-31T03:48:00.000Z',
      until: null,
      text: '第 42 棒在跑（最后输出于 11:48）',
    };
    harness.snapshot = snapshot({ running: [running] });
    await render();

    const line = $('relay-model-running')!;
    expect(line.textContent).toContain('第 42 棒');
    expect(line.textContent).toContain('开发');
    expect(line.textContent).toContain('任务 K10a');
    expect(line.textContent).toContain('已跑 12 分钟');
    expect(line.textContent).toContain('baidu / deepseek-v4.1-flash-1017');
  });
});
