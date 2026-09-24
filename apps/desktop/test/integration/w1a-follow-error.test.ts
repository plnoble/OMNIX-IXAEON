// @vitest-environment jsdom
/**
 * 2026-09-24 用户验证 W1a：点「关注」没反应。实际是出错了，但错误提示显示在研究页最顶上，
 * 往下翻看方向卡片时看不见。整合方改为错误写在那张卡片上；这里守住它。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  listResearchTopics: vi.fn(async () => ({
    mode: 'approved-sources-plus-search',
    searchConfigured: true,
    notice: '',
    topics: [] as unknown[],
  })),
  listResearchRequirements: vi.fn(async () => []),
  previewWatchDirections: vi.fn(async () => ({ memoryCount: 2 })),
  suggestWatchDirections: vi.fn(async () => ({
    searchConfigured: true,
    directions: [
      {
        question: '合成方向',
        publicDescription: 'local model runtime',
        relatedGoalId: 'goal-1',
        relatedProjectId: null,
        basis: [{ id: 'goal-1', statement: '合成目标' }],
      },
    ],
  })),
  followWatchDirection: vi.fn(async () => {
    throw new Error('合成的关注失败原因');
  }),
  skipWatchDirection: vi.fn(async () => undefined),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: harness,
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

async function click(testId: string): Promise<void> {
  const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  if (!el) throw new Error(`没有 ${testId}`);
  await act(async () => {
    el.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

it('点「关注」失败时，错误写在那张方向卡片上，按钮还在可以再点', async () => {
  await act(async () => {
    root.render(createElement(ResearchPage, { projects: [] }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await click('research-suggest');
  await click('research-suggest-ok');
  await click('research-direction-follow-0');
  const card = document.querySelector('[data-testid="research-direction-0"]');
  expect(card?.textContent).toContain('合成的关注失败原因');
  expect(document.querySelector('[data-testid="research-direction-follow-0"]')).not.toBeNull();
});
