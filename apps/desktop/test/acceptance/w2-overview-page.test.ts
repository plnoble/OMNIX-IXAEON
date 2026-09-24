// @vitest-environment jsdom
/**
 * W2 验收（总览，规格 docs/委派/W2-研究内容显示中文.md 条件 8）
 *
 * 总览三块的标题有中文就显示中文，没有就显示原标题：
 * 「符合你要求的新发现」「最近的新发现」「研究里你标过值得行动」。
 * 链接照旧打开原网址。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  getPersonalOverview: vi.fn(),
  markFindingsSeen: vi.fn(async () => ({ ok: true as const })),
  markMatchedFindingsSeen: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getPersonalOverview: harness.getPersonalOverview,
    markFindingsSeen: harness.markFindingsSeen,
    markMatchedFindingsSeen: harness.markMatchedFindingsSeen,
    proposeProjectRelations: vi.fn(async () => []),
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { PersonalOverviewPage } from '../../src/renderer/src/pages/Overview.js';

let host: HTMLDivElement;
let root: Root;

function overview() {
  return {
    generatedAt: '2026-09-24T00:00:00.000Z',
    goals: [],
    constraints: [],
    unknowns: [],
    conflicts: [],
    pastSuggestions: [],
    pastSources: [],
    projects: [],
    relations: [],
    coverage: { projectCount: 0, analyzedSources: 0, unanalyzedSources: 0, unassignedItems: 0 },
    matchedFindings: [
      {
        id: 'matched-zh',
        title: 'Matched original title',
        titleZh: '对上的中文标题',
        url: 'https://example.com/matched-zh',
        topicQuestion: '合成主题',
        fetchedAt: '2026-09-24T08:00:00.000Z',
        isNew: false,
        matches: [{ requirementId: 'r1', text: '合成要求', reason: '对上了' }],
      },
      {
        id: 'matched-raw',
        title: 'Matched without translation',
        titleZh: null,
        url: 'https://example.com/matched-raw',
        topicQuestion: '合成主题',
        fetchedAt: '2026-09-24T08:00:00.000Z',
        isNew: false,
        matches: [{ requirementId: 'r1', text: '合成要求', reason: '对上了' }],
      },
    ],
    recentFindings: [
      {
        id: 'recent-zh',
        title: 'Recent original title',
        titleZh: '最近的中文标题',
        url: 'https://example.com/recent-zh',
        topicQuestion: '合成主题',
        fetchedAt: '2026-09-24T08:00:00.000Z',
        isNew: false,
      },
      {
        id: 'recent-raw',
        title: 'Recent without translation',
        titleZh: null,
        url: 'https://example.com/recent-raw',
        topicQuestion: '合成主题',
        fetchedAt: '2026-09-24T08:00:00.000Z',
        isNew: false,
      },
    ],
    researchFollowUps: [
      {
        id: 'follow-zh',
        title: 'Follow-up original title',
        titleZh: '值得行动的中文标题',
        url: 'https://example.com/follow-zh',
        excerpt: '',
        action_reason: null,
        related_project_id: null,
      },
      {
        id: 'follow-raw',
        title: 'Follow-up without translation',
        titleZh: null,
        url: 'https://example.com/follow-raw',
        excerpt: '',
        action_reason: null,
        related_project_id: null,
      },
    ],
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  harness.getPersonalOverview.mockResolvedValue(overview());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function linkText(href: string): string {
  const link = host.querySelector(`a[href="${href}"]`);
  if (!link) throw new Error(`没有链接 ${href}`);
  return link.textContent ?? '';
}

it('条件 8：总览三块的标题有中文就显示中文，没有就显示原标题', async () => {
  await act(async () => {
    root.render(
      createElement(PersonalOverviewPage, {
        state: { dataDir: 'C:\\tmp\\w2', serverRunning: false, serverPort: 0 } as never,
      }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(linkText('https://example.com/matched-zh')).toBe('对上的中文标题');
  expect(linkText('https://example.com/matched-raw')).toBe('Matched without translation');
  expect(linkText('https://example.com/recent-zh')).toBe('最近的中文标题');
  expect(linkText('https://example.com/recent-raw')).toBe('Recent without translation');
  expect(linkText('https://example.com/follow-zh')).toBe('值得行动的中文标题');
  expect(linkText('https://example.com/follow-raw')).toBe('Follow-up without translation');
});
