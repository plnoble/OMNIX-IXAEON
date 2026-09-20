// @vitest-environment jsdom
/**
 * U1 验收（界面，v2 规格）：docs/委派/U1-研究页忙状态.md
 * 1. 一个主题在检查（IPC 未 resolve）时：这个主题的「立即检查」不可点，
 *    新建关注的创建按钮仍可点，另一个主题的按钮也仍可点。
 * 2. 检查期间显示「正在检查…（已 N 秒）」，秒数会涨；检查返回后这行消失。
 * 3. 等待超过 5 分钟：文案变成「还没回来…后台继续跑」，出现「停止等待」；
 *    点它之后这个主题的按钮恢复可用、提示消失；后来 IPC 真的返回时不报错、照常刷新列表。
 * 4. 返回的运行记录里 error 非空：这个主题下面显示那行黄字（class=warn），内容含降级说明；
 *    同一主题再次返回空 error 后旧提示消失。停止等待后这次检查返回的降级说明仍显示。
 * 5. 检查失败（IPC reject）：只影响这个主题的按钮，错误提示里能看出是哪个主题。
 *    启用/暂停等操作失败时，错误提示同样带主题名。
 * 6. 停止等待后再检查同一主题：旧请求最后返回不覆盖新检查的搜索结果和降级提示。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  listResearchTopics: vi.fn(),
  checkResearchTopicNow: vi.fn(),
  createResearchTopic: vi.fn(),
  previewWatchDirections: vi.fn(),
  suggestWatchDirections: vi.fn(),
  setResearchTopicEnabled: vi.fn(),
  setResearchTopicPaused: vi.fn(),
  setResearchBudget: vi.fn(),
  addResearchSource: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listResearchTopics: harness.listResearchTopics,
    checkResearchTopicNow: harness.checkResearchTopicNow,
    createResearchTopic: harness.createResearchTopic,
    previewWatchDirections: harness.previewWatchDirections,
    suggestWatchDirections: harness.suggestWatchDirections,
    setResearchTopicEnabled: harness.setResearchTopicEnabled,
    setResearchTopicPaused: harness.setResearchTopicPaused,
    setResearchBudget: harness.setResearchBudget,
    addResearchSource: harness.addResearchSource,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { ResearchPage } from '../../src/renderer/src/pages/Research.js';

let container: HTMLDivElement;
let root: Root;

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
  topics: [topic('a', '关注甲'), topic('b', '关注乙')],
};

function okCheck(error: string | null = null) {
  return {
    run: {
      id: 'run-1',
      status: 'succeeded',
      pages_fetched: 0,
      findings_new: 0,
      error,
    },
    findings: [],
    mode: 'approved-sources-only' as const,
    searchUsed: false,
    searchCandidates: [],
    searchError: null,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(harness)) fn.mockReset();
  harness.listResearchTopics.mockResolvedValue(SNAPSHOT);
  harness.checkResearchTopicNow.mockResolvedValue(okCheck());
  harness.createResearchTopic.mockResolvedValue({ id: 'new' });
  harness.previewWatchDirections.mockResolvedValue({ memoryCount: 0 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
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
const disabled = (id: string) => ($(id) as HTMLButtonElement).disabled;

async function fillCreate() {
  await act(async () => {
    const el = $('research-question') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, '新的关注问题');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('条件 1：一个主题在检查时，只有它的立即检查不可点；创建和另一个主题仍可点', async () => {
  const held = deferred<ReturnType<typeof okCheck>>();
  harness.checkResearchTopicNow.mockReturnValueOnce(held.promise);
  await renderPage();
  await fillCreate();
  expect(disabled('research-create')).toBe(false);
  expect(disabled('research-check-a')).toBe(false);
  expect(disabled('research-check-b')).toBe(false);

  await click('research-check-a');
  expect(disabled('research-check-a')).toBe(true);
  expect(disabled('research-create')).toBe(false);
  expect(disabled('research-check-b')).toBe(false);
  expect(disabled('research-add-source-b')).toBe(false);

  await act(async () => {
    held.resolve(okCheck());
    await held.promise;
  });
});

it('条件 2：检查期间显示正在检查与秒数，返回后消失', async () => {
  const held = deferred<ReturnType<typeof okCheck>>();
  harness.checkResearchTopicNow.mockReturnValueOnce(held.promise);
  await renderPage();
  await click('research-check-a');
  expect($('research-checking-a')?.textContent).toMatch(/正在检查…（已 0 秒）/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect($('research-checking-a')?.textContent).toMatch(/正在检查…（已 1 秒）/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect($('research-checking-a')?.textContent).toMatch(/正在检查…（已 2 秒）/);

  await act(async () => {
    held.resolve(okCheck());
    await held.promise;
  });
  expect($('research-checking-a')).toBeNull();
});

it('条件 3：等超过 5 分钟可停止等待；之后 IPC 返回不报错、仍刷新列表', async () => {
  const held = deferred<ReturnType<typeof okCheck>>();
  harness.checkResearchTopicNow.mockReturnValueOnce(held.promise);
  await renderPage();
  const listsBefore = harness.listResearchTopics.mock.calls.length;
  await click('research-check-a');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  });
  expect($('research-checking-a')?.textContent).toMatch(/还没回来/);
  expect($('research-checking-a')?.textContent).toMatch(/后台继续/);
  expect($('research-stop-waiting-a')).not.toBeNull();

  await click('research-stop-waiting-a');
  expect($('research-checking-a')).toBeNull();
  expect($('research-stop-waiting-a')).toBeNull();
  expect(disabled('research-check-a')).toBe(false);
  expect($('error-banner')).toBeNull();

  await act(async () => {
    held.resolve(okCheck());
    await held.promise;
  });
  expect($('error-banner')).toBeNull();
  expect(harness.listResearchTopics.mock.calls.length).toBeGreaterThan(listsBefore);
});

it('条件 4：run.error 非空时这个主题下显示黄字；为空时不显示', async () => {
  await renderPage();
  harness.checkResearchTopicNow.mockResolvedValueOnce(
    okCheck('模型研读失败 1 次，已降级为规则研读'),
  );
  await click('research-check-a');
  const notice = $('research-run-notice-a');
  expect(notice?.textContent).toContain('已降级为规则研读');
  expect(notice?.classList.contains('warn')).toBe(true);
  expect($('research-topic-a')?.contains(notice)).toBe(true);
  expect($('research-run-notice-b')).toBeNull();

  harness.checkResearchTopicNow.mockResolvedValueOnce(okCheck(null));
  await click('research-check-b');
  expect($('research-run-notice-b')).toBeNull();
  expect($('research-run-notice-a')?.textContent).toContain('已降级为规则研读');

  harness.checkResearchTopicNow.mockResolvedValueOnce(okCheck(null));
  await click('research-check-a');
  expect($('research-run-notice-a')).toBeNull();
});

it('停止等待后，这次检查返回的降级说明仍显示', async () => {
  const held = deferred<ReturnType<typeof okCheck>>();
  harness.checkResearchTopicNow.mockReturnValueOnce(held.promise);
  await renderPage();
  await click('research-check-a');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  });
  await click('research-stop-waiting-a');
  expect($('research-checking-a')).toBeNull();
  await act(async () => {
    held.resolve(okCheck('模型研读失败 1 次，已降级为规则研读'));
    await held.promise;
  });
  expect($('research-run-notice-a')?.textContent).toContain('已降级为规则研读');
  expect($('error-banner')).toBeNull();
});

it('条件 5：检查失败只影响这个主题，错误里能看出是哪个主题', async () => {
  harness.checkResearchTopicNow.mockRejectedValueOnce(new Error('网关超时'));
  await renderPage();
  await fillCreate();
  await click('research-check-a');
  expect($('error-banner')?.textContent).toContain('关注甲');
  expect($('error-banner')?.textContent).toContain('网关超时');
  expect(disabled('research-check-a')).toBe(false);
  expect(disabled('research-check-b')).toBe(false);
  expect(disabled('research-create')).toBe(false);
});

it('条件 5：主题操作失败时错误也带主题名', async () => {
  harness.setResearchTopicPaused.mockRejectedValueOnce(new Error('已暂停失败'));
  await renderPage();
  const pauseBtn = Array.from(container.querySelectorAll('button')).find((el) =>
    el.textContent?.includes('暂停'),
  ) as HTMLButtonElement;
  await act(async () => {
    pauseBtn.click();
  });
  expect($('error-banner')?.textContent).toContain('关注甲');
  expect($('error-banner')?.textContent).toContain('已暂停失败');
});

it('停止等待后再检查：旧请求最后返回不覆盖新结果', async () => {
  const first = deferred<ReturnType<typeof okCheck>>();
  const second = deferred<ReturnType<typeof okCheck>>();
  harness.checkResearchTopicNow
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await renderPage();
  await click('research-check-a');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  });
  await click('research-stop-waiting-a');
  await click('research-check-a');
  await act(async () => {
    second.resolve(okCheck('模型研读失败 1 次，已降级为规则研读'));
    await second.promise;
  });
  expect($('research-run-notice-a')?.textContent).toContain('已降级为规则研读');
  await act(async () => {
    first.resolve(okCheck(null));
    await first.promise;
  });
  expect($('research-run-notice-a')?.textContent).toContain('已降级为规则研读');
  expect($('error-banner')).toBeNull();
});
