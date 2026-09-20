// @vitest-environment jsdom
/**
 * S3b 补充测试（Codex 复审后加，不改锁定的 s3b-agent-sessions-page.test.ts）：
 *
 * 1. 估算响应乱序到达：旧响应不覆盖新估算；全部取消后，在途响应不让估算复活。
 * 2. 导入在途：关掉与重开清单被禁止（配合结果守卫，旧结果进不了新清单）；重开新清单不带旧结果。
 * 3. 条件 1 补强：成功选择那次的 pickFiles 在 listAgentSessions 之前。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  listResult: {
    listId: 'list-1',
    sessions: [
      {
        id: 1,
        tool: 'claude_code' as const,
        title: '合成会话1',
        cwd: null,
        projectId: null,
        mtimeMs: Date.parse('2026-09-20T01:02:03.000Z'),
        size: 2048,
        status: 'new' as const,
      },
      {
        id: 2,
        tool: 'codex' as const,
        title: '合成会话2',
        cwd: null,
        projectId: null,
        mtimeMs: Date.parse('2026-09-19T08:00:00.000Z'),
        size: 1024,
        status: 'updated' as const,
      },
    ],
    unrecognizedCount: 0,
    subagentCount: 0,
  },
  pickFiles: vi.fn(),
  listAgentSessions: vi.fn(),
  estimateAgentSessions: vi.fn(),
  importAgentSessions: vi.fn(),
  listSources: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listSources: harness.listSources,
    getSettings: harness.getSettings,
    pickFiles: harness.pickFiles,
    listAgentSessions: harness.listAgentSessions,
    estimateAgentSessions: harness.estimateAgentSessions,
    importAgentSessions: harness.importAgentSessions,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { SourcesPage } from '../../src/renderer/src/pages/Sources.js';

let container: HTMLDivElement;
let root: Root;
const onProjectChange = vi.fn();
const projects = [{ id: 'p1', name: '合成项目一' }];

beforeEach(() => {
  for (const fn of [
    harness.pickFiles,
    harness.listAgentSessions,
    harness.estimateAgentSessions,
    harness.importAgentSessions,
    harness.listSources,
    harness.getSettings,
  ]) {
    fn.mockReset();
  }
  harness.pickFiles.mockImplementation(async () => ({
    ticket: 'ticket-1234',
    paths: ['D:/synthetic/s'],
  }));
  harness.listResult = { ...harness.listResult, listId: 'list-1' };
  harness.listAgentSessions.mockImplementation(async () => harness.listResult);
  harness.estimateAgentSessions.mockImplementation(async () => ({
    items: [],
    userChars: 40000,
    assistantChars: 20000,
  }));
  harness.importAgentSessions.mockImplementation(async () => ({
    created: 0,
    unchanged: 0,
    failed: [],
  }));
  harness.listSources.mockImplementation(async () => []);
  harness.getSettings.mockImplementation(async () => ({
    config: { captureEnabled: true, autoAnalyze: false },
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(SourcesPage, { projects, projectId: null, onProjectChange }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

async function click(testId: string): Promise<void> {
  await act(async () => {
    $(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function setChecked(testId: string, value: boolean): Promise<void> {
  const input = $(testId) as HTMLInputElement;
  if (input.checked === value) return;
  await act(async () => {
    input.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function openList(): Promise<void> {
  await render();
  await click('sources-import-agent-sessions');
}

type EstimateResult = { items: unknown[]; userChars: number; assistantChars: number };

function deferredEstimate(): {
  promise: Promise<EstimateResult>;
  resolve: (v: EstimateResult) => void;
} {
  let resolve!: (v: EstimateResult) => void;
  const promise = new Promise<EstimateResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

it('估算乱序：旧响应不覆盖新估算；全部取消后在途响应不让估算复活', async () => {
  const e1 = deferredEstimate();
  const e2 = deferredEstimate();
  harness.estimateAgentSessions
    .mockImplementationOnce(() => e1.promise)
    .mockImplementationOnce(() => e2.promise);
  await openList();

  await setChecked('agent-session-check-1', true); // 请求 1（慢）
  await setChecked('agent-session-check-2', true); // 请求 2（快）
  await e2.resolve({ items: [], userChars: 30000, assistantChars: 10000 });
  await settle();
  expect($('agent-sessions-estimate')?.textContent).toContain('约 4 万字');
  expect($('agent-sessions-estimate')?.textContent).toContain('你说的 3 万、AI 回答 1 万');

  await e1.resolve({ items: [], userChars: 20000, assistantChars: 10000 }); // 旧响应后到
  await settle();
  expect($('agent-sessions-estimate')?.textContent).toContain('约 4 万字');

  const e3 = deferredEstimate();
  harness.estimateAgentSessions.mockImplementationOnce(() => e3.promise);
  await setChecked('agent-session-check-1', false);
  await setChecked('agent-session-check-2', false); // 全部取消，估算应消失
  expect($('agent-sessions-estimate')).toBeNull();
  await e3.resolve({ items: [], userChars: 20000, assistantChars: 10000 });
  await settle();
  expect($('agent-sessions-estimate')).toBeNull(); // 在途响应不让它复活
});

it('导入期间不能关清单/换清单；结果只显示在本清单，重开新清单不带旧结果', async () => {
  let resolveImport!: (v: {
    created: number;
    unchanged: number;
    failed: Array<{ id: number; message: string }>;
  }) => void;
  harness.importAgentSessions.mockImplementationOnce(
    () =>
      new Promise((res) => {
        resolveImport = res;
      }),
  );
  await openList();
  await click('agent-sessions-select-new');
  await click('agent-sessions-import');
  expect(harness.importAgentSessions).toHaveBeenCalledWith({
    listId: 'list-1',
    ids: [1, 2],
    projectId: null,
  });
  // 导入在途：关掉与重开都被禁止（配合结果守卫，旧结果进不了新清单）
  expect(($('agent-sessions-close') as HTMLButtonElement).disabled).toBe(true);
  expect(($('sources-import-agent-sessions') as HTMLButtonElement).disabled).toBe(true);

  await resolveImport({ created: 2, unchanged: 0, failed: [] });
  await settle();
  expect($('agent-sessions-result')?.textContent).toContain('新导入 2 个');

  // 完成后关掉、换一份新清单（listId 变了）：不带旧结果
  await click('agent-sessions-close');
  expect($('agent-sessions-result')).toBeNull();
  harness.listResult = { ...harness.listResult, listId: 'list-2' };
  await click('sources-import-agent-sessions');
  expect($('agent-sessions-list')).not.toBeNull();
  expect($('agent-sessions-result')).toBeNull();
});

it('条件 1 补强：成功选择那次的 pickFiles 在 listAgentSessions 之前', async () => {
  await render();
  await click('sources-import-agent-sessions');
  expect(harness.pickFiles.mock.invocationCallOrder[0]).toBeLessThan(
    harness.listAgentSessions.mock.invocationCallOrder[0],
  );
  expect(harness.pickFiles).nthCalledWith(1, 'directory');
});
