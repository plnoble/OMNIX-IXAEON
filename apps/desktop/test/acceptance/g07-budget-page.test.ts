// @vitest-environment jsdom
/**
 * G07 验收（界面，规格 docs/委派/G07-搜索预算按天恢复.md 条件 5）
 *
 * 研究页按主题类型显示额度：
 * - 按天的：「今天还能搜 N 次（每天 3 次）」；用完：「今天的搜索额度用完了，明天恢复」
 * - 累计的：「还能搜 N 次（总额度）」；用完：「搜索额度用完了，要继续请调高上限」
 *
 * 整合方复审时补（2026-09-24）：按主题卡片（research-topic-<id>）逐张核对，文案不许串到
 * 别的主题上；原稿只看整页文字，把两种文案对调也能过。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function topic(id: string, daily: number | null, cap: number) {
  return {
    id,
    question: id,
    public_description: 'local model runtime',
    enabled: true,
    paused: false,
    paid_budget_mode: 'request_cap',
    request_cap: cap,
    daily_request_cap: daily,
    last_success_at: null,
    last_failure_at: null,
    last_failure: null,
    consecutive_failures: 0,
    next_check_at: null,
    sources: [],
    findings: [],
    runs: [],
  };
}

const harness = vi.hoisted(() => ({
  listResearchTopics: vi.fn(async () => ({
    mode: 'approved-sources-plus-search',
    searchConfigured: true,
    notice: '',
    topics: [] as unknown[],
  })),
  listResearchRequirements: vi.fn(async () => []),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listResearchTopics: harness.listResearchTopics,
    listResearchRequirements: harness.listResearchRequirements,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { ResearchPage } from '../../src/renderer/src/pages/Research.js';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it('条件 5：按天与累计的主题各显示自己的额度文案和用完提示', async () => {
  harness.listResearchTopics.mockResolvedValue({
    mode: 'approved-sources-plus-search',
    searchConfigured: true,
    notice: '',
    topics: [
      topic('按天有余量', 3, 2),
      topic('按天用完', 3, 0),
      topic('累计有余量', null, 2),
      topic('累计用完', null, 0),
    ],
  });
  await act(async () => {
    root.render(createElement(ResearchPage, { projects: [] }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const card = (id: string): string => {
    const el = document.querySelector(`[data-testid="research-topic-${id}"]`);
    if (!el) throw new Error(`没有主题卡片「${id}」`);
    return el.textContent ?? '';
  };
  expect(card('按天有余量')).toContain('今天还能搜 2 次（每天 3 次）');
  expect(card('按天用完')).toContain('今天的搜索额度用完了，明天恢复');
  expect(card('累计有余量')).toContain('还能搜 2 次（总额度）');
  expect(card('累计用完')).toContain('搜索额度用完了，要继续请调高上限');
  // 不串
  expect(card('按天有余量')).not.toContain('总额度');
  expect(card('按天用完')).not.toContain('调高上限');
  expect(card('累计有余量')).not.toContain('每天');
  expect(card('累计用完')).not.toContain('明天恢复');
});
