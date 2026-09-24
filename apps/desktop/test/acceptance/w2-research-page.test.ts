// @vitest-environment jsdom
/**
 * W2 验收（研究页，规格 docs/委派/W2-研究内容显示中文.md 条件 8）
 *
 * 发现：标题显示 title_zh（没有就原标题），链接照旧打开原网址；有 summary_zh 时
 * 正文显示中文摘要，下面「原文」可展开（<details>），里面是原标题和原摘录；
 * 没有中文时照旧显示原摘录。
 * 搜索候选：titleZh / snippetZh 优先，原文同样可展开。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function finding(id: string, zh: { title: string | null; summary: string | null }) {
  return {
    id,
    title: `${id} 的原标题`,
    url: `https://example.com/${id}`,
    excerpt: `${id} 的原摘录`,
    title_zh: zh.title,
    summary_zh: zh.summary,
    claimed_published_at: null,
    fetched_at: '2026-09-24T08:00:00.000Z',
    evidence_class: 'publisher',
    limitations: null,
    action_worthy: false,
    action_reason: null,
  };
}

function topic() {
  return {
    id: 'topic-1',
    question: '合成主题',
    public_description: 'local model runtime',
    enabled: true,
    paused: false,
    paid_budget_mode: 'none',
    request_cap: 0,
    daily_request_cap: null,
    last_success_at: null,
    last_failure_at: null,
    last_failure: null,
    consecutive_failures: 0,
    next_check_at: null,
    sources: [],
    findings: [
      finding('有中文', { title: '中文标题', summary: '中文摘要' }),
      finding('没中文', { title: null, summary: null }),
    ],
    runs: [],
  };
}

const harness = vi.hoisted(() => ({
  listResearchTopics: vi.fn(async () => ({
    mode: 'approved-sources-only' as const,
    searchConfigured: false,
    notice: '',
    topics: [] as unknown[],
  })),
  listResearchRequirements: vi.fn(async () => []),
  checkResearchTopicNow: vi.fn(async () => ({
    run: { status: 'succeeded', pages_fetched: 0, findings_new: 0, error: null },
    findings: [],
    mode: 'approved-sources-plus-search',
    searchUsed: true,
    searchError: null,
    searchCandidates: [
      {
        title: 'English candidate title',
        url: 'https://example.com/cand-en',
        snippet: 'English candidate snippet',
        titleZh: '候选的中文标题',
        snippetZh: '候选的中文摘要',
      },
      {
        title: '中文候选标题',
        url: 'https://example.com/cand-zh',
        snippet: '中文候选摘要',
        titleZh: null,
        snippetZh: null,
      },
    ],
  })),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listResearchTopics: harness.listResearchTopics,
    listResearchRequirements: harness.listResearchRequirements,
    checkResearchTopicNow: harness.checkResearchTopicNow,
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
  harness.listResearchTopics.mockResolvedValue({
    mode: 'approved-sources-only',
    searchConfigured: false,
    notice: '',
    topics: [topic()],
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(ResearchPage, { projects: [] }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 发现所在的那一行（按原网址找，链接照旧打开原网址）。 */
function findingRow(id: string): HTMLElement {
  const link = host.querySelector(`a[href="https://example.com/${id}"]`);
  const row = link?.closest('li');
  if (!row) throw new Error(`没有发现「${id}」`);
  return row as HTMLElement;
}

it('条件 8：有中文的发现显示中文，原文可展开，链接照旧', async () => {
  await render();
  const row = findingRow('有中文');
  const link = row.querySelector('a')!;
  expect(link.textContent).toBe('中文标题');
  expect(link.getAttribute('href')).toBe('https://example.com/有中文');
  // 正文是中文摘要，原摘录收在「原文」里
  expect(row.querySelector('p')?.textContent).toContain('中文摘要');
  const details = row.querySelector('details');
  expect(details).not.toBeNull();
  expect(details!.textContent).toContain('原文');
  expect(details!.textContent).toContain('有中文 的原标题');
  expect(details!.textContent).toContain('有中文 的原摘录');
});

it('条件 8：没有中文的发现照旧显示原标题和原摘录，没有「原文」', async () => {
  await render();
  const row = findingRow('没中文');
  expect(row.querySelector('a')!.textContent).toBe('没中文 的原标题');
  expect(row.textContent).toContain('没中文 的原摘录');
  expect(row.querySelector('details')).toBeNull();
  // 同一页上有中文的那条必须真的显示中文：只渲染原文的实现两条都会「通过」
  expect(findingRow('有中文').querySelector('a')!.textContent).toBe('中文标题');
});

it('条件 8：搜索候选中文优先，原文可展开；没有中文的照旧', async () => {
  await render();
  const button = host.querySelector('[data-testid="research-check-topic-1"]') as HTMLButtonElement;
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const box = host.querySelector('[data-testid="research-search-topic-1"]') as HTMLElement;
  const english = box.querySelector('a[href="https://example.com/cand-en"]')!.closest('li')!;
  expect(english.querySelector('a')!.textContent).toBe('候选的中文标题');
  const details = english.querySelector('details')!;
  expect(details.textContent).toContain('原文');
  expect(details.textContent).toContain('English candidate title');
  expect(details.textContent).toContain('English candidate snippet');
  const chinese = box.querySelector('a[href="https://example.com/cand-zh"]')!.closest('li')!;
  expect(chinese.querySelector('a')!.textContent).toBe('中文候选标题');
  expect(chinese.textContent).toContain('中文候选摘要');
  expect(chinese.querySelector('details')).toBeNull();
});
