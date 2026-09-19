// @vitest-environment jsdom
/**
 * W1a 验收条件 1、3（界面）：docs/委派/W1a-关注方向.md
 * 1. 点按钮先出确认，条数对；取消就什么都不发。
 * 3. 模型返回 5 个方向：显示 5 张卡；格式坏了报错、不显示卡片。
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
  harness.listResearchTopics.mockReset();
  harness.previewWatchDirections.mockReset();
  harness.suggestWatchDirections.mockReset();
  harness.followWatchDirection.mockReset();
  harness.skipWatchDirection.mockReset();
  harness.createResearchTopic.mockReset();
  harness.listResearchTopics.mockResolvedValue({
    mode: 'approved-sources-only',
    searchConfigured: false,
    notice: '当前未配置搜索服务。',
    topics: [],
  });
  harness.previewWatchDirections.mockResolvedValue({ memoryCount: 3 });
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

it('条件 1：点按钮先出确认，条数对；取消不发模型', async () => {
  await renderPage();
  expect($('research-suggest')).not.toBeNull();
  await act(async () => {
    ($('research-suggest') as HTMLButtonElement).click();
  });
  expect($('research-suggest-confirm')).not.toBeNull();
  expect($('research-suggest-count')?.textContent).toMatch(/3/);
  expect(harness.suggestWatchDirections).not.toHaveBeenCalled();
  await act(async () => {
    ($('research-suggest-cancel') as HTMLButtonElement).click();
  });
  expect(harness.suggestWatchDirections).not.toHaveBeenCalled();
  expect($('research-suggest-confirm')).toBeNull();
});

it('条件 3：返回 5 个方向显示 5 张卡；格式坏了报错、不显示卡片', async () => {
  harness.suggestWatchDirections.mockResolvedValueOnce({
    searchConfigured: false,
    directions: Array.from({ length: 5 }, (_, i) => ({
      question: `内部问题 ${i}`,
      publicDescription: `公开检索 ${i}`,
      why: [`依据 ${i}`],
    })),
  });
  await renderPage();
  await act(async () => {
    ($('research-suggest') as HTMLButtonElement).click();
  });
  await act(async () => {
    ($('research-suggest-ok') as HTMLButtonElement).click();
  });
  expect($('research-direction-0')).not.toBeNull();
  expect($('research-direction-4')).not.toBeNull();
  expect($('research-direction-5')).toBeNull();
  expect($('research-direction-public-0')?.textContent).toContain('公开检索 0');
  expect($('research-direction-budget-0')?.textContent).toMatch(/只看你加的来源|最多搜 3 次/);

  harness.suggestWatchDirections.mockRejectedValueOnce(new Error('解析失败'));
  await act(async () => {
    ($('research-suggest') as HTMLButtonElement).click();
  });
  await act(async () => {
    ($('research-suggest-ok') as HTMLButtonElement).click();
  });
  expect(container.textContent).toContain('解析失败');
  expect($('research-direction-0')).toBeNull();
});
