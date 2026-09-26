// @vitest-environment jsdom
/**
 * N2 验收（研究页，规格 docs/委派/N2-研究页显示判定和理由.md）
 *
 * 条件 2：没有要求的主题不显示判定行。
 * 条件 3：摘要行只写非 0 的项；全部对上时写「全部对上（总览已提醒）」。
 * 条件 4：展开后逐条显示要求原文、判定和理由；没判的写「还没判」。
 * 条件 5：窗口外且一条都没判过的发现不显示判定行；窗口外但判过的照常显示。
 *
 * data-testid：摘要行 finding-judgments-<发现id>，展开区 finding-judgments-detail-<发现id>。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
const recent = new Date().toISOString();
const old = new Date(Date.now() - 9 * DAY).toISOString();

function finding(
  id: string,
  fetchedAt: string,
  judgments: Array<{
    text: string;
    verdict: 'meets' | 'fails' | 'unknown' | null;
    reason: string | null;
  }>,
) {
  return {
    id,
    title: `${id} 的标题`,
    url: `https://example.com/${id}`,
    excerpt: '摘录',
    claimed_published_at: null,
    fetched_at: fetchedAt,
    evidence_class: 'publisher',
    limitations: null,
    action_worthy: false,
    action_reason: null,
    judgments: judgments.map((j, i) => ({ requirementId: `r-${id}-${i}`, ...j })),
  };
}

function topic(id: string, findings: ReturnType<typeof finding>[]) {
  return {
    id,
    question: `${id} 的方向`,
    public_description: '',
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
    findings,
    runs: [],
  };
}

const three = [
  { text: '要求一', verdict: 'meets' as const, reason: '写了内存容量' },
  { text: '要求二', verdict: 'unknown' as const, reason: '摘录没有提到模型' },
  { text: '要求三', verdict: null, reason: null },
];

const harness = vi.hoisted(() => ({
  topics: [] as unknown[],
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listResearchTopics: vi.fn(async () => ({
      mode: 'approved-sources-only' as const,
      searchConfigured: false,
      notice: '',
      topics: harness.topics,
    })),
    listResearchRequirements: vi.fn(async () => []),
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

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(ResearchPage, { projects: [] }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function summary(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="finding-judgments-${id}"]`);
}

it('条件 3、4：摘要只写非 0 的项，展开后逐条显示，没判的写还没判', async () => {
  harness.topics = [topic('有要求', [finding('部分', recent, three)])];
  await render();
  const line = summary('部分');
  expect(line).not.toBeNull();
  expect(line!.textContent).toContain('对照你的 3 条要求');
  expect(line!.textContent).toContain('对上 1');
  expect(line!.textContent).toContain('看不出来 1');
  expect(line!.textContent).toContain('还没判 1');
  expect(line!.textContent).not.toContain('对不上');
  const detail = host.querySelector('[data-testid="finding-judgments-detail-部分"]')!;
  expect(detail.tagName).toBe('DETAILS');
  const rows = [...detail.querySelectorAll('li')].map((li) => li.textContent);
  expect(rows).toEqual([
    '要求一：对上（写了内存容量）',
    '要求二：看不出来（摘录没有提到模型）',
    '要求三：还没判',
  ]);
});

it('条件 3：全部对上时写全部对上（总览已提醒）', async () => {
  harness.topics = [
    topic('全对', [
      finding('全对上', recent, [
        { text: '要求一', verdict: 'meets', reason: '对上了' },
        { text: '要求二', verdict: 'meets', reason: '也对上了' },
      ]),
    ]),
  ];
  await render();
  expect(summary('全对上')!.textContent).toContain('全部对上（总览已提醒）');
});

it('条件 2：没有要求的主题不显示判定行', async () => {
  harness.topics = [topic('没要求', [finding('一条', recent, [])])];
  await render();
  expect(summary('一条')).toBeNull();
});

it('条件 5：窗口外且一条都没判过的不显示；判过的照常显示', async () => {
  harness.topics = [
    topic('窗口外', [
      finding('没判过', old, [
        { text: '要求一', verdict: null, reason: null },
        { text: '要求二', verdict: null, reason: null },
      ]),
      finding('判过', old, [
        { text: '要求一', verdict: 'fails', reason: '对不上' },
        { text: '要求二', verdict: null, reason: null },
      ]),
    ]),
  ];
  await render();
  expect(summary('没判过')).toBeNull();
  const line = summary('判过');
  expect(line).not.toBeNull();
  expect(line!.textContent).toContain('对不上 1');
  expect(line!.textContent).toContain('还没判 1');
});
