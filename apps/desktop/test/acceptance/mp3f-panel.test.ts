// @vitest-environment jsdom
/**
 * MP3f 验收条件 18：驾驶舱调度器面板不再显示「替补审查」「替补整合方」两行；
 * 调度器配置里原有的这两个角色原样保留（这里只验界面不显示；配置不动由 setRelayModel 不碰这两个角色保证）。
 *
 * 整合方 11-05 重写：原来的快照桩形状不对（缺 sources 等），页面渲染时就抛 TypeError，测不到条件本身。
 * 改成跟 k10a-cockpit-models.test.ts 同一套桩：读到的配置里仍有这两个角色（configured、有当前值），
 * 面板上不出现这两行，也不出现它们的名字；开发 / 整合 / 审查三行照旧在。
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitSnapshot, RelayModelRow, RelayModels, SourceHealth } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-11-05T12:00:00+08:00');

const harness = vi.hoisted(() => ({ snapshot: null as unknown, models: null as unknown }));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getCockpitSnapshot: async () => harness.snapshot,
    getRelayModels: async () => JSON.parse(JSON.stringify(harness.models)) as RelayModels,
    setRelayModel: async () => ({ ok: true as const }),
    listProjects: async () => [],
    listMatchedFindings: async () => [],
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { CockpitPage } from '../../src/renderer/src/pages/Cockpit.js';

const health = (): SourceHealth => ({
  status: 'ok',
  readAt: NOW.toISOString(),
  lastEventAt: null,
  note: null,
});

const snapshot = (): CockpitSnapshot => ({
  generatedAt: NOW.toISOString(),
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
  configured: false,
  note: null,
  ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness.snapshot = snapshot();
  harness.models = {
    roles: [
      row({
        role: 'developer',
        current: 'gw-a / model-a1',
        options: ['gw-a / model-a1'],
        configured: true,
      }),
      row({
        role: 'integrator',
        current: '默认',
        options: ['默认', 'opus', 'sonnet', 'haiku'],
        configured: true,
      }),
      row({ role: 'reviewer', current: '跟 Codex 自己的设置', configured: true }),
      // 配置里这两个角色还在、也配过：面板照样不显示
      row({
        role: 'reviewerSubstitute',
        current: 'gw-a / model-a1',
        options: ['gw-a / model-a1'],
        configured: true,
      }),
      row({
        role: 'integratorSubstitute',
        current: 'gw-a / model-a1',
        options: ['gw-a / model-a1'],
        configured: true,
      }),
    ],
  } satisfies RelayModels;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(CockpitPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

describe('MP3f 条件 18：面板不再显示作废的两行', () => {
  it('面板在，开发 / 整合 / 审查三行在；没有「替补审查」「替补整合方」两行，也没有它们的名字', () => {
    expect($('cockpit-relay-models')).not.toBeNull();
    for (const role of ['developer', 'integrator', 'reviewer']) {
      expect($(`relay-model-row-${role}`), `缺少角色行 ${role}`).not.toBeNull();
    }
    expect($('relay-model-row-reviewerSubstitute')).toBeNull();
    expect($('relay-model-row-integratorSubstitute')).toBeNull();
    expect($('relay-model-row-substitutes')).toBeNull();
    const text = $('cockpit-relay-models')!.textContent ?? '';
    expect(text).not.toContain('替补审查');
    expect(text).not.toContain('替补整合方');
  });
});
