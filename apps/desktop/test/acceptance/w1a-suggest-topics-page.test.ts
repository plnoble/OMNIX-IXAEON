// @vitest-environment jsdom
/**
 * W1a 验收（界面，v2 规格，执行方写、整合方 2026-09-19 复审后补全并重锁）：docs/委派/W1a-关注方向.md
 * 1. 点按钮先出确认，条数对；取消就什么都不发。
 * 3. 模型返回 5 个方向：显示 5 张卡，对外检索描述、依据（记忆原文）、预算说明都对（按搜索有没有配置）；
 *    格式坏了：报错、不显示卡片。
 * 4、5（界面这一头）. 「关注」把这个方向的问题、对外检索描述、关联目标与项目原样交给主进程；
 *    「不关注」交问题和对外检索描述；点过的卡片不再有这两个按钮。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  listResearchTopics: vi.fn(),
  previewWatchDirections: vi.fn(),
  suggestWatchDirections: vi.fn(),
  followWatchDirection: vi.fn(),
  skipWatchDirection: vi.fn(),
  createResearchTopic: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listResearchTopics: harness.listResearchTopics,
    previewWatchDirections: harness.previewWatchDirections,
    suggestWatchDirections: harness.suggestWatchDirections,
    followWatchDirection: harness.followWatchDirection,
    skipWatchDirection: harness.skipWatchDirection,
    createResearchTopic: harness.createResearchTopic,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { ResearchPage } from '../../src/renderer/src/pages/Research.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const fn of Object.values(harness)) fn.mockReset();
  harness.listResearchTopics.mockResolvedValue({
    mode: 'approved-sources-only',
    searchConfigured: false,
    notice: '当前未配置搜索服务。',
    topics: [],
  });
  harness.previewWatchDirections.mockResolvedValue({ memoryCount: 3 });
  harness.followWatchDirection.mockResolvedValue({ id: 'topic-1' });
  harness.skipWatchDirection.mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(createElement(ResearchPage, { projects: [] }));
  });
}

const $ = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const click = async (id: string) => {
  await act(async () => {
    ($(id) as HTMLButtonElement).click();
  });
};

function directions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    question: `内部问题 ${i}`,
    publicDescription: `公开检索 ${i}`,
    basis: [{ id: `m${i}`, statement: `依据原文 ${i}` }],
    relatedGoalId: `goal-${i}`,
    relatedProjectId: i === 0 ? 'project-1' : null,
  }));
}

async function suggest(result: unknown) {
  harness.suggestWatchDirections.mockResolvedValueOnce(result);
  await click('research-suggest');
  await click('research-suggest-ok');
}

it('条件 1：点按钮先出确认，条数对；取消不发模型', async () => {
  await renderPage();
  expect($('research-suggest')).not.toBeNull();
  await click('research-suggest');
  expect($('research-suggest-confirm')).not.toBeNull();
  expect($('research-suggest-count')?.textContent).toMatch(/3/);
  expect(harness.suggestWatchDirections).not.toHaveBeenCalled();
  await click('research-suggest-cancel');
  expect(harness.suggestWatchDirections).not.toHaveBeenCalled();
  expect($('research-suggest-confirm')).toBeNull();
});

it('条件 3：5 个方向显示 5 张卡：对外检索描述、依据原文、预算说明（搜索没配置）', async () => {
  await renderPage();
  await suggest({ searchConfigured: false, directions: directions(5) });
  expect($('research-direction-0')).not.toBeNull();
  expect($('research-direction-4')).not.toBeNull();
  expect($('research-direction-5')).toBeNull();
  expect($('research-direction-public-0')?.textContent).toContain('公开检索 0');
  expect($('research-direction-basis-0')?.textContent).toContain('依据原文 0');
  expect($('research-direction-budget-0')?.textContent).toContain('只看你加的来源');
  expect($('research-direction-budget-0')?.textContent).not.toContain('最多搜 3 次');
});

it('条件 3：搜索已配置时，预算说明是每天自动找一次、最多搜 3 次', async () => {
  await renderPage();
  await suggest({ searchConfigured: true, directions: directions(1) });
  expect($('research-direction-budget-0')?.textContent).toContain('最多搜 3 次');
  expect($('research-direction-budget-0')?.textContent).not.toContain('只看你加的来源');
});

it('条件 3：格式坏了报错、不显示卡片', async () => {
  await renderPage();
  harness.suggestWatchDirections.mockRejectedValueOnce(new Error('解析失败'));
  await click('research-suggest');
  await click('research-suggest-ok');
  expect(container.textContent).toContain('解析失败');
  expect($('research-direction-0')).toBeNull();
});

it('关注：原样交出问题、对外检索描述、关联目标与项目；点过后没有按钮了', async () => {
  await renderPage();
  await suggest({ searchConfigured: false, directions: directions(2) });
  await click('research-direction-follow-0');
  expect(harness.followWatchDirection).toHaveBeenCalledWith({
    question: '内部问题 0',
    publicDescription: '公开检索 0',
    relatedGoalId: 'goal-0',
    relatedProjectId: 'project-1',
  });
  expect($('research-direction-follow-0')).toBeNull();
  expect($('research-direction-skip-0')).toBeNull();
});

it('不关注：交出问题和对外检索描述；点过后没有按钮了', async () => {
  await renderPage();
  await suggest({ searchConfigured: false, directions: directions(2) });
  await click('research-direction-skip-1');
  expect(harness.skipWatchDirection).toHaveBeenCalledWith({
    question: '内部问题 1',
    publicDescription: '公开检索 1',
  });
  expect(harness.followWatchDirection).not.toHaveBeenCalled();
  expect($('research-direction-follow-1')).toBeNull();
  expect($('research-direction-skip-1')).toBeNull();
});
