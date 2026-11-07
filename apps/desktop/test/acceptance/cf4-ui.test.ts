// @vitest-environment jsdom
/**
 * CF4 条件 10（界面，jsdom，替身 api）：
 * - complete 的助手消息下有 message-to-task-<id>；用户消息、failed 助手消息下没有；
 * - 打开表单后目标框预填那一轮的用户消息正文；开始下拉 message-to-task-from 的选项是结束那条之前的全部用户消息；
 * - 验收条件为空时 message-to-task-submit 不可点；
 * - 提交时 createTaskFromConversation 收到的参数跟表单一致（按行拆、去空行）；
 * - 建完出现 message-task-link-<taskId>，点了调 onOpenTask(taskId)；
 * - 任务页卡片 task-origin-<taskId> 显示「来自对话「<标题>」第 a–b 条」。
 *
 * 现在界面还没做，本文件应当红。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  tasks: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getState: async () => ({
      version: '0',
      dataDir: 'T',
      setupComplete: true,
      serverRunning: false,
      serverPort: 0,
      platform: 'win32',
      envOverride: true,
      dataDirSource: 'env',
    }),
    listProjects: async () => [],
    listConversations: async () => [],
    listTodos: async () => [],
    getSettings: async () => ({
      config: { modelName: 'demo-a', savedModels: [], uses: {}, fallbacks: {}, codingChain: [] },
    }),
    getConversation: async () => ({
      conversation: { id: 'c1', title: '记账讨论', projectId: null },
      messages: h.messages,
    }),
    listConversationTasks: async () => h.tasks,
    createTaskFromConversation: async (input: Record<string, unknown>) => {
      h.created.push(input);
      const task = { id: 'task-new', goal: input['goal'], status: 'draft' };
      h.tasks.push(task);
      return task;
    },
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let opened: string[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  h.created = [];
  h.tasks = [];
  opened = [];
  const now = new Date().toISOString();
  h.messages = [
    {
      id: 'm1',
      conversationId: 'c1',
      seq: 1,
      role: 'user',
      content: '帮我想想记账小程序要哪些页面',
      status: 'complete',
      createdAt: now,
      updatedAt: now,
      meta: {},
    },
    {
      id: 'm2',
      conversationId: 'c1',
      seq: 2,
      role: 'assistant',
      content: '先做记一笔和列表',
      status: 'complete',
      createdAt: now,
      updatedAt: now,
      meta: {},
    },
    {
      id: 'm3',
      conversationId: 'c1',
      seq: 3,
      role: 'user',
      content: '那先做记一笔这页',
      status: 'complete',
      createdAt: now,
      updatedAt: now,
      meta: {},
    },
    {
      id: 'm4',
      conversationId: 'c1',
      seq: 4,
      role: 'assistant',
      content: '好，记一笔这页要有金额和备注',
      status: 'complete',
      createdAt: now,
      updatedAt: now,
      meta: {},
    },
  ];
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(AskPage, {
        projects: [],
        openConversationId: 'c1',
        onOpenTask: (id: string) => opened.push(id),
      }),
    ),
  );
  await settle();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const el = (id: string): HTMLElement => {
  const n = document.querySelector(`[data-testid="${id}"]`);
  if (!n) throw new Error('找不到 ' + id);
  return n as HTMLElement;
};
const maybe = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('CF4 条件 10：按钮出现的位置', () => {
  it('complete 助手消息下有；用户消息、failed 助手消息下没有', async () => {
    h.messages[3]!['status'] = 'failed';
    act(() => root?.unmount());
    document.body.innerHTML = '';
    const c = document.createElement('div');
    document.body.appendChild(c);
    root = createRoot(c);
    act(() => root!.render(createElement(AskPage, { projects: [], openConversationId: 'c1' })));
    await settle();
    expect(maybe('message-to-task-m2')).toBeTruthy();
    expect(maybe('message-to-task-m1')).toBeNull();
    expect(maybe('message-to-task-m4')).toBeNull();
  });
});

describe('CF4 条件 10：表单与提交', () => {
  it('目标预填、开始下拉选项、验收条件空时不能提交、提交参数一致、建完出现链接', async () => {
    act(() => el('message-to-task-m4').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const goal = el('message-to-task-goal') as HTMLTextAreaElement;
    expect(goal.value).toBe('帮我想想记账小程序要哪些页面');
    const from = el('message-to-task-from') as HTMLSelectElement;
    const labels = Array.from(from.options).map((o) => o.textContent ?? '');
    expect(labels.length).toBe(2); // 前两条用户消息（m1、m3），结束是 m4
    const submit = el('message-to-task-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const acc = el('message-to-task-acceptance') as HTMLTextAreaElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(acc, '记一笔能保存\n\n账目能列出');
      acc.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect((el('message-to-task-submit') as HTMLButtonElement).disabled).toBe(false);
    act(() =>
      el('message-to-task-submit').dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await settle();
    expect(h.created.length).toBe(1);
    expect(h.created[0]).toMatchObject({
      conversationId: 'c1',
      toMessageId: 'm4',
      goal: '帮我想想记账小程序要哪些页面',
      acceptance: ['记一笔能保存', '账目能列出'],
    });
    const link = el('message-task-link-task-new');
    act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(opened).toContain('task-new');
  });
});
