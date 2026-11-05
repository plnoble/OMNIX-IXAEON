// @vitest-environment jsdom
/**
 * MP3f 验收条件 18：驾驶舱调度器面板不再显示「替补审查」「替补整合方」两行；
 * 调度器配置里原有的这两个角色原样保留（这里只验界面不显示，配置不动由主进程负责）。
 *
 * 条件 16、17（「审查/整合不能跟开发选成同一个模型」的拒绝规则）落在主进程保存链上，
 * 规格没写死可单独调用的函数名；见交付说明「写不成测试 / 有问题」一节，未自行发明接口。
 *
 * 现在面板还在显示这两行（LABEL 里仍有 reviewerSubstitute / integratorSubstitute），本文件应当红。
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  models: {
    roles: [
      { role: 'developer', label: '开发', current: 'gw/gpt-x', options: ['gw/gpt-x'] },
      { role: 'reviewer', label: '审查', current: 'gw/review', options: ['gw/review'] },
      { role: 'integrator', label: '整合', current: 'gw/int', options: ['gw/int'] },
      { role: 'reviewerSubstitute', label: '替补审查', current: 'gw/r2', options: ['gw/r2'] },
      { role: 'integratorSubstitute', label: '替补整合方', current: 'gw/i2', options: ['gw/i2'] },
    ],
    running: [],
  } as unknown,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getCockpitSnapshot: async () => ({
      generatedAt: '2026-11-05T00:00:00.000Z',
      project: null,
      goals: [],
      tasks: [],
      running: [],
      sources: [],
      jobs: { queued: 0, running: 0, failed: 0 },
      relay: { turns: [] },
    }),
    getRelayModels: async () => JSON.parse(JSON.stringify(h.models)),
    setRelayModel: async () => ({ ok: true as const }),
    listProjects: async () => [],
    listMatchedFindings: async () => [],
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { CockpitPage } from '../../src/renderer/src/pages/Cockpit.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(CockpitPage)));
  await settle();
  await settle();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('MP3f 条件 18：面板不再显示作废的两行', () => {
  it('没有「替补审查」「替补整合方」两行', () => {
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('替补审查');
    expect(text).not.toContain('替补整合方');
  });
});
