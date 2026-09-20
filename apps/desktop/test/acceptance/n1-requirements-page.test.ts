// @vitest-environment jsdom
/**
 * N1 验收（界面，v2 规格）：docs/委派/N1-要求清单只在对上时提醒.md
 *
 * 条件 7：概览页有对上的发现时显示 overview-matched-findings，每条列出对上的
 *          要求与理由；没有时整块不出现；点「都看过了」调 markMatchedFindingsSeen
 *          并刷新；侧栏角标 nav-research-badge 显示未看条数，0 不显示。
 *          W1b 的「最近的新发现」仍在它下面。
 * 条件 8（界面这一头）：研究页能加、能删要求；没有要求时提示「没有要求就不会提醒你」；
 *          加超过 200 字的报错不写库（IPC reject，列表不变）。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
  const emptyOverview = {
    generatedAt: '2026-09-20T00:00:00.000Z',
    goals: [] as unknown[],
    constraints: [] as unknown[],
    unknowns: [] as unknown[],
    conflicts: [] as unknown[],
    pastSuggestions: [] as unknown[],
    pastSources: [] as unknown[],
    projects: [] as unknown[],
    relations: [] as unknown[],
    researchFollowUps: [] as unknown[],
    recentFindings: [
      {
        id: 'recent-1',
        title: 'W1b 最近发现',
        url: 'https://example.com/recent',
        topicQuestion: '合成方向',
        fetchedAt: '2026-09-20T12:00:00.000Z',
        isNew: true,
      },
    ],
    matchedFindings: [] as Array<{
      id: string;
      title: string;
      url: string;
      topicQuestion: string;
      fetchedAt: string;
      isNew: boolean;
      matches: Array<{ requirementId: string; text: string; reason: string }>;
    }>,
    coverage: { projectCount: 0, analyzedSources: 0, unanalyzedSources: 0, unassignedItems: 0 },
  };
  return {
    emptyOverview,
    overview: { ...emptyOverview },
    getPersonalOverview: vi.fn(),
    markFindingsSeen: vi.fn(async () => ({ ok: true as const })),
    markMatchedFindingsSeen: vi.fn(async () => ({ ok: true as const })),
    listMatchedFindings: vi.fn(async () => [] as unknown[]),
    listResearchTopics: vi.fn(),
    listResearchRequirements: vi.fn(),
    addResearchRequirement: vi.fn(),
    removeResearchRequirement: vi.fn(),
    getState: vi.fn(),
    listProjects: vi.fn(),
    proposeProjectRelations: vi.fn(async () => []),
  };
});

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getPersonalOverview: harness.getPersonalOverview,
    markFindingsSeen: harness.markFindingsSeen,
    markMatchedFindingsSeen: harness.markMatchedFindingsSeen,
    listMatchedFindings: harness.listMatchedFindings,
    listResearchTopics: harness.listResearchTopics,
    listResearchRequirements: harness.listResearchRequirements,
    addResearchRequirement: harness.addResearchRequirement,
    removeResearchRequirement: harness.removeResearchRequirement,
    getState: harness.getState,
    listProjects: harness.listProjects,
    proposeProjectRelations: harness.proposeProjectRelations,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { PersonalOverviewPage } from '../../src/renderer/src/pages/Overview.js';
import { ResearchPage } from '../../src/renderer/src/pages/Research.js';
import App from '../../src/renderer/src/App.js';

let container: HTMLDivElement;
let root: Root;
const state = { dataDir: 'C:\\tmp\\n1', serverRunning: false, serverPort: 0 } as never;

function topic(id: string, question: string) {
  return {
    id,
    question,
    public_description: '',
    enabled: true,
    paused: false,
    paid_budget_mode: 'none',
    request_cap: 0,
    last_success_at: null,
    last_failure_at: null,
    last_failure: null,
    consecutive_failures: 0,
    next_check_at: null,
    sources: [],
    findings: [],
    runs: [] as Array<{
      id: string;
      status: string;
      pages_fetched: number;
      findings_new: number;
      error: string | null;
    }>,
  };
}

const SNAPSHOT = {
  mode: 'approved-sources-only' as const,
  searchConfigured: false,
  notice: '当前未配置搜索服务。',
  topics: [topic('a', '关注甲')],
};

beforeEach(() => {
  for (const fn of Object.values(harness)) {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  }
  harness.overview = {
    ...harness.emptyOverview,
    matchedFindings: [
      {
        id: 'match-1',
        title: '对上的发现',
        url: 'https://example.com/match',
        topicQuestion: 'N1 合成方向',
        fetchedAt: '2026-09-20T12:00:00.000Z',
        isNew: true,
        matches: [
          { requirementId: 'req-1', text: '内存 24GB 以上', reason: '写了 24GB' },
          { requirementId: 'req-2', text: '能跑本地大模型', reason: '写了能装 Qwen' },
        ],
      },
    ],
  };
  harness.getPersonalOverview.mockImplementation(async () => harness.overview);
  harness.listMatchedFindings.mockImplementation(async () => harness.overview.matchedFindings);
  harness.listResearchTopics.mockResolvedValue(SNAPSHOT);
  harness.listResearchRequirements.mockResolvedValue([]);
  harness.addResearchRequirement.mockResolvedValue({
    id: 'req-new',
    topic_id: 'a',
    text: '内存 24GB 以上',
    sort_order: 1,
  });
  harness.removeResearchRequirement.mockResolvedValue({ ok: true });
  harness.getState.mockResolvedValue({
    setupComplete: true,
    version: '0.2.0',
    dataDir: 'C:\\tmp\\n1',
    serverRunning: false,
    serverPort: 0,
    platform: 'win32',
  });
  harness.listProjects.mockResolvedValue([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => {
    ($(id) as HTMLButtonElement).click();
  });
};

async function renderOverview() {
  await act(async () => {
    root.render(createElement(PersonalOverviewPage, { state }));
  });
}

async function renderResearch() {
  await act(async () => {
    root.render(createElement(ResearchPage, { projects: [] }));
  });
}

it('条件 7：有对上发现时显示这一块、列出要求与理由；都看过了调 IPC 并刷新；没有时不出现；最近发现仍在下面', async () => {
  await renderOverview();
  const block = $('overview-matched-findings');
  expect(block).not.toBeNull();
  expect($('matched-finding-match-1')).not.toBeNull();
  expect($('matched-finding-new-match-1')).not.toBeNull();
  expect(block?.textContent).toContain('对上的发现');
  expect(block?.textContent).toContain('内存 24GB 以上');
  expect(block?.textContent).toContain('写了 24GB');
  expect(block?.textContent).toContain('能跑本地大模型');
  expect(block?.textContent).toContain('写了能装 Qwen');
  const matched = $('overview-matched-findings');
  const recent = $('overview-recent-findings');
  expect(recent).not.toBeNull();
  expect(
    Boolean(
      matched &&
      recent &&
      !!(matched.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING),
    ),
  ).toBe(true);

  harness.overview = {
    ...harness.overview,
    matchedFindings: harness.overview.matchedFindings.map((f) => ({ ...f, isNew: false })),
  };
  await act(async () => {
    ($('matched-findings-seen') as HTMLButtonElement).click();
  });
  expect(harness.markMatchedFindingsSeen).toHaveBeenCalledTimes(1);
  expect(harness.getPersonalOverview.mock.calls.length).toBeGreaterThan(1);
  expect($('matched-finding-new-match-1')).toBeNull();
  expect($('matched-finding-match-1')).not.toBeNull();

  harness.overview = { ...harness.overview, matchedFindings: [] };
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await renderOverview();
  expect($('overview-matched-findings')).toBeNull();
  expect($('overview-recent-findings')).not.toBeNull();
});

it('条件 7：侧栏角标显示未看条数，0 不显示', async () => {
  harness.listMatchedFindings.mockResolvedValue([
    { id: 'm1', isNew: true },
    { id: 'm2', isNew: true },
    { id: 'm3', isNew: false },
  ]);
  await act(async () => {
    root.render(createElement(App));
  });
  const badge = $('nav-research-badge');
  expect(badge).not.toBeNull();
  expect(badge?.textContent).toMatch(/2/);

  harness.listMatchedFindings.mockResolvedValue([{ id: 'm3', isNew: false }]);
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(App));
  });
  expect($('nav-research-badge')).toBeNull();
});

it('条件 8：研究页能加、能删要求；没有要求时有提示；超 200 字报错不写库', async () => {
  await renderResearch();
  expect($('research-requirements-a')).not.toBeNull();
  expect($('research-requirements-empty-a')?.textContent).toContain('没有要求就不会提醒你');

  const input = $('research-requirement-input-a') as HTMLInputElement;
  await act(async () => {
    input.value = '内存 24GB 以上';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('research-requirement-add-a');
  expect(harness.addResearchRequirement).toHaveBeenCalledWith({
    topicId: 'a',
    text: '内存 24GB 以上',
  });

  harness.listResearchRequirements.mockResolvedValue([
    { id: 'req-1', topic_id: 'a', text: '内存 24GB 以上', sort_order: 1 },
  ]);
  harness.listResearchTopics.mockResolvedValue(SNAPSHOT);
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await renderResearch();
  expect($('research-requirement-req-1')?.textContent).toContain('内存 24GB 以上');
  expect($('research-requirements-empty-a')).toBeNull();
  await click('research-requirement-remove-req-1');
  expect(harness.removeResearchRequirement).toHaveBeenCalledWith('req-1');

  harness.addResearchRequirement.mockRejectedValueOnce(new Error('超过 200 字'));
  const long = $('research-requirement-input-a') as HTMLInputElement;
  await act(async () => {
    long.value = '字'.repeat(201);
    long.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('research-requirement-add-a');
  expect($('error-banner')?.textContent).toContain('超过 200 字');
  expect($('research-requirement-req-1')?.textContent).toContain('内存 24GB 以上');
});
