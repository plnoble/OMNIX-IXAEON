// @vitest-environment jsdom
/**
 * U4 验收（规格 docs/委派/U4-回报一点就到那条任务.md）：
 * 对话里的回报下面有按钮，点了就到任务页，停在这条任务上，改动已经展开。
 *
 * 1. 回报消息下面有按钮，data-testid 带任务号；普通回答、用户说的话下面没有。
 *    回报的每一种都显示（等你验收、没做成、取消了、落地结果、缺执行器）。
 * 2. 点按钮：切到任务页；那条任务的卡片调了 scrollIntoView；改动是展开的，
 *    getCodingTaskChanges 以这个任务号调了一次。
 * 3. 那条任务没有改动（changedPaths 是空的）：照样切过去、滚到它，不调 getCodingTaskChanges。
 * 4. 那条任务已经删掉：切到任务页，页面正常，不报错。
 * 5. 回到对话再点同一个按钮：又滚一次、改动又是展开的（哪怕中间用户把它收起了）。
 * 6. 从左边导航进任务页：不滚、不自动展开任何一条。
 * 7. 回报的文字没变：按钮在正文下面，正文本身不改（taskReport.ts 不在本单改动里；
 *    D1、D3、D7b 的锁定测试另跑）。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingTask, ConversationMessage, TaskChanges } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  rows: [] as CodingTask[],
  changes: null as TaskChanges | null,
  changesCalls: [] as string[],
  changesError: null as string | null,
  listCodingTasks: vi.fn(),
  listSkillCandidates: vi.fn(async () => []),
  getCodingTaskChanges: vi.fn(),
  scrolls: [] as string[],
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listCodingTasks: harness.listCodingTasks,
    listSkillCandidates: harness.listSkillCandidates,
    getCodingTaskChanges: harness.getCodingTaskChanges,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskMessage } from '../../src/renderer/src/pages/AskMessage.js';
import { TasksPage, type TaskFocus } from '../../src/renderer/src/pages/Tasks.js';

let container: HTMLDivElement;
let root: Root;

function task(id: string, patch: Record<string, unknown>): CodingTask {
  return {
    id,
    goal: `合成任务 ${id}`,
    status: 'pending_accept',
    version: 1,
    ...patch,
  } as unknown as CodingTask;
}

const report = (changedPaths: string[]): string =>
  JSON.stringify({
    claimedSuccess: true,
    summary: 'done',
    changedPaths,
    testsModified: false,
    raw: '',
  });

function message(
  role: 'assistant' | 'user',
  meta: Record<string, unknown>,
  content: string,
): ConversationMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    role,
    content,
    status: 'complete',
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    runId: null,
    engine: role === 'assistant' ? 'ask' : null,
    modelName: null,
    citations: [],
    meta,
    errorMessage: null,
  } as ConversationMessage;
}

beforeEach(() => {
  harness.listCodingTasks.mockClear();
  harness.listSkillCandidates.mockClear();
  harness.getCodingTaskChanges.mockClear();
  harness.changesCalls = [];
  harness.changesError = null;
  harness.scrolls = [];
  harness.changes = {
    total: 1,
    files: [{ path: 'note.txt', kind: 'modified', diff: '+新的一行\n-旧的一行\n', note: null }],
  };
  harness.getCodingTaskChanges.mockImplementation(async (id: string) => {
    harness.changesCalls.push(id);
    if (harness.changesError) throw new Error(harness.changesError);
    return harness.changes;
  });
  harness.rows = [
    task('t-rich', { executor_report_json: report(['note.txt']) }),
    task('t-empty', { executor_report_json: report([]) }),
  ];
  harness.listCodingTasks.mockImplementation(async () => ({
    executor: 'fake',
    realDispatchEnabled: false,
    notice: '合成说明',
    tasks: harness.rows,
  }));
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    harness.scrolls.push(this.getAttribute('data-testid') ?? '');
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderMessage(
  m: ConversationMessage,
  onOpenTask: (taskId: string) => void = () => undefined,
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(AskMessage, {
        message: m,
        showNotice: false,
        expandedRef: null,
        onToggleRef: () => undefined,
        onOpenTask,
      }),
    );
  });
}

async function renderTasks(focus: TaskFocus | null = null): Promise<void> {
  await act(async () => {
    root.render(createElement(TasksPage, { projects: [], focus }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('U4 回报一点就到那条任务', () => {
  it('条件 1：回报下面有按钮，testid 带任务号；普通回答和用户的话下面没有', async () => {
    const kinds = ['pending_accept', 'failed', 'cancelled', 'landed_branch', 'codex_missing'];
    for (const status of kinds) {
      await renderMessage(
        message(
          'assistant',
          { kind: 'task_report', taskId: 't-rich', status },
          '「合成目标」做完了，等你验收。\n去任务页看改动，点接受。',
        ),
      );
      const btn = $('task-report-open-t-rich');
      expect(btn, status).toBeTruthy();
      expect(btn!.textContent).toContain('到任务页看这条任务');
    }
    await renderMessage(message('assistant', {}, '这是普通回答，没有回报。'));
    expect($('task-report-open-t-rich')).toBeNull();
    expect(container.textContent).not.toContain('到任务页看这条任务');
    await renderMessage(
      message('user', { kind: 'task_report', taskId: 't-rich', status: 'failed' }, '我自己说的话'),
    );
    expect($('task-report-open-t-rich')).toBeNull();
  });

  it('条件 1：taskId 不是字符串、kind 不是 task_report 的不显示', async () => {
    await renderMessage(
      message('assistant', { kind: 'task_report', taskId: 12, status: 'failed' }, '回报'),
    );
    expect(container.textContent).not.toContain('到任务页看这条任务');
    await renderMessage(message('assistant', { kind: 'other', taskId: 't-rich' }, '不是回报'));
    expect($('task-report-open-t-rich')).toBeNull();
  });

  it('条件 2：有改动的任务，focus 到了就滚进视野、改动展开，getCodingTaskChanges 调一次', async () => {
    await renderTasks({ taskId: 't-rich', at: 1 });
    expect(harness.scrolls).toEqual(['task-t-rich']);
    expect(harness.changesCalls).toEqual(['t-rich']);
    expect($('task-changes-t-rich')).toBeTruthy();
    expect($('task-changes-toggle-t-rich')!.textContent).toContain('收起');
    expect($('task-changes-t-rich')!.textContent).toContain('note.txt');
    // 没有被点到的那条不展开
    expect($('task-changes-t-empty')).toBeNull();
  });

  it('条件 3：没有改动的任务照样滚过去，不调 getCodingTaskChanges', async () => {
    await renderTasks({ taskId: 't-empty', at: 2 });
    expect(harness.scrolls).toEqual(['task-t-empty']);
    expect(harness.changesCalls).toEqual([]);
    expect($('task-changes-toggle-t-empty')).toBeNull();
    expect($('task-changes-t-empty')).toBeNull();
  });

  it('条件 4：任务已经删掉，页面正常，不报错、不提示', async () => {
    await renderTasks({ taskId: 'gone', at: 3 });
    expect($('page-tasks')).toBeTruthy();
    expect($('error-banner')).toBeNull();
    expect(harness.scrolls).toEqual([]);
    expect(harness.changesCalls).toEqual([]);
    expect(container.textContent).not.toContain('gone');
  });

  it('条件 5：同一条再来一次新的 focus（用户中间收起过），又滚一次、改动又展开', async () => {
    await renderTasks({ taskId: 't-rich', at: 10 });
    expect(harness.changesCalls).toEqual(['t-rich']);
    const toggle = $('task-changes-toggle-t-rich')!;
    await click(toggle);
    expect($('task-changes-t-rich')).toBeNull();
    expect(toggle.textContent).toContain('看改动');
    harness.scrolls = [];
    await renderTasks({ taskId: 't-rich', at: 11 });
    expect(harness.scrolls).toEqual(['task-t-rich']);
    expect(harness.changesCalls).toEqual(['t-rich', 't-rich']);
    expect($('task-changes-t-rich')).toBeTruthy();
    expect($('task-changes-toggle-t-rich')!.textContent).toContain('收起');
  });

  it('条件 5：同一个 focus 对象再渲染一次，不重复滚、不重复读', async () => {
    const focus = { taskId: 't-rich', at: 20 };
    await renderTasks(focus);
    harness.scrolls = [];
    await renderTasks(focus);
    expect(harness.scrolls).toEqual([]);
    expect(harness.changesCalls).toEqual(['t-rich']);
  });

  it('条件 6：不带 focus（从左边导航进来）不滚、不自动展开', async () => {
    await renderTasks(null);
    expect(harness.scrolls).toEqual([]);
    expect(harness.changesCalls).toEqual([]);
    expect($('task-changes-t-rich')).toBeNull();
    expect($('task-changes-toggle-t-rich')!.textContent).toContain('看改动');
  });

  it('条件 2/6：自己点「看改动」仍是展开并读一次；点「收起」不读', async () => {
    await renderTasks(null);
    const toggle = $('task-changes-toggle-t-rich')!;
    await click(toggle);
    expect(harness.changesCalls).toEqual(['t-rich']);
    expect($('task-changes-t-rich')).toBeTruthy();
    await click(toggle);
    expect($('task-changes-t-rich')).toBeNull();
    expect(harness.changesCalls).toEqual(['t-rich']);
  });

  it('条件 7：按钮在正文下面，回报文字一个字不改', async () => {
    const text = '「合成目标」做完了，等你验收。\n去任务页看改动，点接受。';
    const opened: string[] = [];
    await renderMessage(
      message(
        'assistant',
        { kind: 'task_report', taskId: 't-rich', status: 'pending_accept' },
        text,
      ),
      (id) => opened.push(id),
    );
    const body = container.querySelector('.answer-text')!;
    expect(body.textContent).toBe(text);
    const btn = $('task-report-open-t-rich')!;
    expect(body.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(btn);
    expect(opened).toEqual(['t-rich']);
  });
});
