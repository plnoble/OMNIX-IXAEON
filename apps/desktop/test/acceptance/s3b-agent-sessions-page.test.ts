// @vitest-environment jsdom
/**
 * S3b 验收（v2 规格：执行方按规格条件写成测试，条件逐条对应）：
 * docs/委派/S3b-编码代理会话选择导入（界面）.md
 *
 * 条件 1：点按钮后按顺序调了 pickFiles('directory') 和 listAgentSessions；取消选择时什么都不调。
 * 条件 2：清单每行的工具、标题、项目、状态显示对（最新的在前）；子代理和认不出的个数那行按规则显示或不显示。
 * 条件 3：默认一个都不勾；导入按钮不能点；「全选有更新的和新的」只勾这两种状态的。
 * 条件 4：勾选后显示估算（数字格式按「约 X 万字」），进行中显示「正在估算…」；全部取消后估算消失。
 * 条件 5：导入调用带的是清单号和勾选的编号；结果显示三类计数，失败的列出原因；然后刷新资料列表。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => {
  const session = (id: number, patch: Record<string, unknown>) => ({
    id,
    tool: 'claude_code',
    title: `合成会话${id}`,
    cwd: null,
    projectId: null,
    mtimeMs: 0,
    size: 2048,
    status: 'new',
    ...patch,
  });
  // 模拟后端按路径序返回（不按时间），「最新的在前」由界面负责
  const sessions = [
    session(3, {
      status: 'updated',
      mtimeMs: Date.parse('2026-09-18T08:00:00.000Z'),
      size: 512,
    }),
    session(1, { projectId: 'p1', mtimeMs: Date.parse('2026-09-20T01:02:03.000Z') }),
    session(2, {
      tool: 'codex',
      mtimeMs: Date.parse('2026-09-19T08:00:00.000Z'),
      size: 1_500_000,
      status: 'imported',
    }),
  ];
  return {
    sessions,
    listResult: { listId: 'list-1', sessions, unrecognizedCount: 3, subagentCount: 2 },
    pickFiles: vi.fn(),
    listAgentSessions: vi.fn(),
    estimateAgentSessions: vi.fn(),
    importAgentSessions: vi.fn(),
    listSources: vi.fn(),
    getSettings: vi.fn(),
  };
});

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
const projects = [
  { id: 'p1', name: '合成项目一' },
  { id: 'p2', name: '合成项目二' },
];

beforeEach(() => {
  for (const fn of [
    harness.pickFiles,
    harness.listAgentSessions,
    harness.estimateAgentSessions,
    harness.importAgentSessions,
    harness.listSources,
    harness.getSettings,
    onProjectChange,
  ]) {
    fn.mockReset();
  }
  harness.pickFiles.mockImplementation(async () => ({
    ticket: 'ticket-1234',
    paths: ['D:/synthetic/s'],
  }));
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

/** React 19 复选框 onChange 走 click；jsdom 下用原生 click()（会翻转勾选并触发事件）。 */
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

const rowTestIds = () =>
  [...container.querySelectorAll('[data-testid^="agent-session-"]')]
    .map((el) => (el as HTMLElement).dataset.testid ?? '')
    .filter((t) => /^agent-session-\d+$/.test(t));

it('条件 1：点按钮按顺序调 pickFiles(directory) 和 listAgentSessions；取消选择时什么都不调', async () => {
  await render();
  harness.pickFiles.mockImplementationOnce(async () => null);
  await click('sources-import-agent-sessions');
  expect(harness.pickFiles).toHaveBeenCalledWith('directory');
  expect(harness.listAgentSessions).not.toHaveBeenCalled();

  await click('sources-import-agent-sessions');
  expect(harness.listAgentSessions).toHaveBeenCalledWith({ ticket: 'ticket-1234' });
  expect(harness.pickFiles.mock.invocationCallOrder[0]).toBeLessThan(
    harness.listAgentSessions.mock.invocationCallOrder[0],
  );
});

it('条件 2：每行显示工具、标题、项目、状态，最新的在前；子代理/认不出的个数那行按规则显示或不显示', async () => {
  await openList();
  expect(rowTestIds()).toEqual(['agent-session-1', 'agent-session-2', 'agent-session-3']);

  expect($('agent-session-1')?.textContent).toContain('Claude Code');
  expect($('agent-session-1')?.textContent).toContain('合成会话1');
  expect($('agent-session-1')?.textContent).toContain('合成项目一');
  expect($('agent-session-1')?.textContent).toContain('新');
  expect($('agent-session-1')?.textContent).toContain('2026-09-20 01:02');
  expect($('agent-session-1')?.textContent).toContain('2.0 KB');

  expect($('agent-session-2')?.textContent).toContain('Codex');
  expect($('agent-session-2')?.textContent).toContain('未归属项目');
  expect($('agent-session-2')?.textContent).toContain('已导入');
  expect($('agent-session-2')?.textContent).toContain('1.4 MB');

  expect($('agent-session-3')?.textContent).toContain('有更新');

  expect($('agent-sessions-unlisted')?.textContent).toBe(
    '另有 2 个 Codex 子代理会话、3 个认不出的文件没列出',
  );

  harness.listResult = {
    ...harness.listResult,
    unrecognizedCount: 0,
    subagentCount: 0,
  };
  await click('agent-sessions-close');
  await click('sources-import-agent-sessions');
  expect($('agent-sessions-unlisted')).toBeNull();
});

it('条件 3：默认一个都不勾、导入按钮不能点；全选有更新的和新的只勾这两种状态的', async () => {
  await openList();
  for (const id of [1, 2, 3]) {
    expect(($(`agent-session-check-${id}`) as HTMLInputElement).checked).toBe(false);
  }
  expect(($('agent-sessions-import') as HTMLButtonElement).disabled).toBe(true);

  await click('agent-sessions-select-new');
  expect(($('agent-session-check-1') as HTMLInputElement).checked).toBe(true);
  expect(($('agent-session-check-3') as HTMLInputElement).checked).toBe(true);
  expect(($('agent-session-check-2') as HTMLInputElement).checked).toBe(false);
  expect(($('agent-sessions-import') as HTMLButtonElement).disabled).toBe(false);
});

it('条件 4：勾选后显示估算（约 X 万字），进行中显示正在估算；全部取消后消失', async () => {
  let resolveEstimate!: (v: {
    items: Array<{ id: number; userChars: number; assistantChars: number }>;
    userChars: number;
    assistantChars: number;
  }) => void;
  harness.estimateAgentSessions.mockImplementationOnce(
    () =>
      new Promise((res) => {
        resolveEstimate = res;
      }),
  );
  await openList();
  await setChecked('agent-session-check-2', true);
  expect(harness.estimateAgentSessions).toHaveBeenCalledWith({
    listId: 'list-1',
    ids: [2],
  });
  expect($('agent-sessions-estimate')?.textContent).toContain('正在估算');

  await act(async () => {
    resolveEstimate({ items: [], userChars: 20000, assistantChars: 10000 });
    await new Promise((r) => setTimeout(r, 0));
  });
  expect($('agent-sessions-estimate')?.textContent).toContain('将发给模型分析：约 3 万字');
  expect($('agent-sessions-estimate')?.textContent).toContain('你说的 2 万、AI 回答 1 万');

  await setChecked('agent-session-check-2', false);
  expect($('agent-sessions-estimate')).toBeNull();
});

it('条件 5：导入带清单号和勾选的编号；结果显示三类计数与失败原因；刷新资料列表', async () => {
  harness.importAgentSessions.mockImplementationOnce(async () => ({
    created: 2,
    unchanged: 1,
    failed: [{ id: 3, message: '合成失败原因' }],
  }));
  await openList();
  await click('agent-sessions-select-new');
  await click('agent-sessions-import');
  expect(harness.importAgentSessions).toHaveBeenCalledWith({
    listId: 'list-1',
    ids: [1, 3],
    projectId: null,
  });
  expect($('agent-sessions-result')?.textContent).toContain('新导入 2 个');
  expect($('agent-sessions-result')?.textContent).toContain('没变化 1 个');
  expect($('agent-sessions-result')?.textContent).toContain('失败 1 个');
  expect($('agent-sessions-result')?.textContent).toContain('3：合成失败原因');
  expect(harness.listSources.mock.calls.length).toBeGreaterThanOrEqual(2);
});
