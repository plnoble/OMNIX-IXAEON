// @vitest-environment jsdom
/**
 * W1b 验收条件 3：概览页显示最近的新发现。
 * docs/委派/W1b-概览页新发现.md
 *
 * 有发现时显示 overview-recent-findings、新的有 recent-finding-new-<id>；
 * 点「都看过了」调 markFindingsSeen 并刷新；没有发现时这一块不出现。
 * 原来的「值得跟进」块仍在。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
  const emptyOverview = {
    generatedAt: '2026-09-19T00:00:00.000Z',
    goals: [] as unknown[],
    constraints: [] as unknown[],
    unknowns: [] as unknown[],
    conflicts: [] as unknown[],
    pastSuggestions: [] as unknown[],
    pastSources: [] as unknown[],
    projects: [] as unknown[],
    relations: [] as unknown[],
    researchFollowUps: [
      {
        id: 'follow-1',
        title: '跟进合成',
        url: 'https://example.com/f',
        excerpt: '',
        action_reason: null,
        related_project_id: null,
      },
    ],
    recentFindings: [] as Array<{
      id: string;
      title: string;
      url: string;
      topicQuestion: string;
      fetchedAt: string;
      isNew: boolean;
    }>,
    coverage: { projectCount: 0, analyzedSources: 0, unanalyzedSources: 0, unassignedItems: 0 },
  };
  return {
    emptyOverview,
    overview: { ...emptyOverview },
    getPersonalOverview: vi.fn(),
    markFindingsSeen: vi.fn(async () => ({ ok: true as const })),
  };
});

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getPersonalOverview: harness.getPersonalOverview,
    markFindingsSeen: harness.markFindingsSeen,
    proposeProjectRelations: vi.fn(async () => []),
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { PersonalOverviewPage } from '../../src/renderer/src/pages/Overview.js';

let container: HTMLDivElement;
let root: Root;
const state = { dataDir: 'C:\\tmp\\w1b', serverRunning: false, serverPort: 0 } as never;

beforeEach(() => {
  harness.getPersonalOverview.mockReset();
  harness.markFindingsSeen.mockClear();
  harness.overview = {
    ...harness.emptyOverview,
    recentFindings: [
      {
        id: 'f-new',
        title: '新发现合成',
        url: 'https://example.com/new',
        topicQuestion: 'W1b 合成方向',
        fetchedAt: '2026-09-19T12:00:00.000Z',
        isNew: true,
      },
      {
        id: 'f-old',
        title: '旧发现合成',
        url: 'https://example.com/old',
        topicQuestion: 'W1b 合成方向',
        fetchedAt: '2026-09-18T12:00:00.000Z',
        isNew: false,
      },
    ],
  };
  harness.getPersonalOverview.mockImplementation(async () => harness.overview);
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

async function renderPage() {
  await act(async () => {
    root.render(createElement(PersonalOverviewPage, { state }));
  });
}

it('条件 3：有发现时显示这一块、新的有标记；点都看过了调 IPC 并刷新；没有发现时不出现', async () => {
  await renderPage();
  expect(container.querySelector('[data-testid="overview-recent-findings"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="recent-finding-f-new"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="recent-finding-new-f-new"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="recent-finding-f-old"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="recent-finding-new-f-old"]')).toBeNull();
  expect(container.querySelector('[data-testid="overview-research-followups"]')).not.toBeNull();

  harness.overview = {
    ...harness.overview,
    recentFindings: harness.overview.recentFindings.map((f) => ({ ...f, isNew: false })),
  };
  await act(async () => {
    (container.querySelector('[data-testid="recent-findings-seen"]') as HTMLButtonElement).click();
  });
  expect(harness.markFindingsSeen).toHaveBeenCalledTimes(1);
  expect(harness.getPersonalOverview.mock.calls.length).toBeGreaterThan(1);

  harness.overview = { ...harness.overview, recentFindings: [] };
  await act(async () => {
    root.unmount();
  });
  root = createRoot(container);
  await renderPage();
  expect(container.querySelector('[data-testid="overview-recent-findings"]')).toBeNull();
  expect(container.querySelector('[data-testid="overview-research-followups"]')).not.toBeNull();
});
