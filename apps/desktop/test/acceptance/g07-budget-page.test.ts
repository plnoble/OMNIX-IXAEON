// @vitest-environment jsdom
/**
 * G07 验收（界面，规格 docs/委派/G07-搜索预算按天恢复.md 条件 5）
 *
 * 研究页按主题类型显示额度：
 * - 按天的：「今天还能搜 N 次（每天 3 次）」；用完：「今天的搜索额度用完了，明天恢复」
 * - 累计的：「还能搜 N 次（总额度）」；用完：「搜索额度用完了，要继续请调高上限」
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
  const text = document.body.textContent ?? '';
  expect(text).toContain('今天还能搜 2 次（每天 3 次）');
  expect(text).toContain('今天的搜索额度用完了，明天恢复');
  expect(text).toContain('还能搜 2 次（总额度）');
  expect(text).toContain('搜索额度用完了，要继续请调高上限');
});
