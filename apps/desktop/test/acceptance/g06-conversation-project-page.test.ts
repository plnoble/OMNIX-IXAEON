// @vitest-environment jsdom
/**
 * G06 验收（界面，规格 docs/委派/G06-对话的项目固定.md）
 *
 * 条件 1：界面当前选 B，打开 A 的旧对话 → 下拉框显示 A 且不可选，
 *         旁边有「换项目请开新对话」（data-testid="ask-project-locked"）。
 * 条件 4：新对话（还没发第一句）下拉框可选；选 B 发出第一句后下拉框锁定为 B。
 * 条件 5：对话列表里每个对话显示所属项目名；没有项目的显示「全部项目」。
 *
 * 对话的项目以对话自己的 projectId 为准（getConversation 返回的 conversation.projectId，
 * 列表项同字段）；项目名从 projects 属性里按 id 取。
 *
 * 整合方复审时补（2026-09-24）：
 * - 条件 2 的界面一半：当前选 B 时打开 A 的旧对话再提问，发出去的必须是 A（审核复现的
 *   就是这一步发错）。
 * - 「新对话」按钮照常可用：打开 A 的旧对话后点「新对话」，下拉框解锁；改选 B 发第一句，
 *   发出去的是 B（后端对还没有消息的对话以第一问的项目为准，见后端测试）。
 *   锁不锁看对话里有没有消息，不看有没有打开对话。
 * - 每个用例前把 getConversation 恢复成默认实现，用例之间不串。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_A = { id: 'proj-a', name: '合成项目A' };
const PROJECT_B = { id: 'proj-b', name: '合成项目B' };

interface Conv {
  id: string;
  title: string;
  projectId: string | null;
}

const harness = vi.hoisted(() => {
  const conversations: Conv[] = [
    { id: 'conv-a', title: 'A 的旧对话', projectId: 'proj-a' },
    { id: 'conv-b', title: 'B 的旧对话', projectId: 'proj-b' },
    { id: 'conv-none', title: '没有项目的对话', projectId: null },
  ];
  /** 默认：旧对话里已经有一条消息。 */
  async function getConversationDefault(id: string) {
    const c = conversations.find((x) => x.id === id)!;
    return {
      conversation: { ...c },
      messages: [
        {
          id: `${id}-m1`,
          role: 'user',
          content: '之前问的',
          seq: 1,
          status: 'complete',
          meta: {},
          citations: [],
        },
      ],
    };
  }
  return {
    conversations,
    listConversations: vi.fn(async () =>
      conversations.map((c) => ({ ...c, lastMessagePreview: '上一句', messageCount: 2 })),
    ),
    getConversationDefault,
    getConversation: vi.fn(getConversationDefault),
    createConversation: vi.fn(),
    askQuestion: vi.fn(),
    listTodos: vi.fn(async () => []),
    onAskProgress: vi.fn(() => () => undefined),
    onAskDelta: vi.fn(() => () => undefined),
    prewarmChat: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listConversations: harness.listConversations,
    getConversation: harness.getConversation,
    createConversation: harness.createConversation,
    askQuestion: harness.askQuestion,
    listTodos: harness.listTodos,
    onAskProgress: harness.onAskProgress,
    onAskDelta: harness.onAskDelta,
    prewarmChat: harness.prewarmChat,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  harness.listConversations.mockClear();
  harness.getConversation.mockReset();
  harness.getConversation.mockImplementation(harness.getConversationDefault);
  harness.createConversation.mockReset();
  harness.askQuestion.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(AskPage, { projects: [PROJECT_A, PROJECT_B] }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function select(): HTMLSelectElement {
  const el = document.querySelector('[data-testid="ask-project-select"]');
  if (!el) throw new Error('没有项目下拉框');
  return el as HTMLSelectElement;
}

/** 受控 select/textarea 设值：走原型 setter，React 的 value tracker 才认。 */
function setValue(el: HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  proto!.set!.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function send(text: string): Promise<void> {
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => {
    setValue(textarea, text);
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await flush();
}

function item(title: string): HTMLElement {
  const el = [...document.querySelectorAll('[data-testid="conversation-item"]')].find((n) =>
    n.textContent?.includes(title),
  );
  if (!el) throw new Error(`列表里没有「${title}」`);
  return el as HTMLElement;
}

describe('G06 对话的项目固定（界面）', () => {
  it('条件 5：对话列表里每个对话显示所属项目名，没有项目的写「全部项目」', async () => {
    await render();
    expect(item('A 的旧对话').textContent).toContain('合成项目A');
    expect(item('B 的旧对话').textContent).toContain('合成项目B');
    expect(item('没有项目的对话').textContent).toContain('全部项目');
  });

  it('条件 1：当前选 B 时打开 A 的旧对话，下拉框回到 A 且锁定，提示换项目请开新对话', async () => {
    await render();
    await act(async () => {
      setValue(select(), PROJECT_B.id);
    });
    expect(select().value).toBe(PROJECT_B.id);
    await act(async () => {
      item('A 的旧对话').querySelector('button')!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(select().value).toBe(PROJECT_A.id);
    expect(select().disabled).toBe(true);
    const hint = document.querySelector('[data-testid="ask-project-locked"]');
    expect(hint?.textContent).toContain('换项目请开新对话');
  });

  it('条件 2（界面，整合方补）：当前选 B 时打开 A 的旧对话再提问，发出去的是 A', async () => {
    harness.askQuestion.mockResolvedValue({ conversationId: 'conv-a' });
    await render();
    await act(async () => {
      setValue(select(), PROJECT_B.id);
    });
    await act(async () => {
      item('A 的旧对话').querySelector('button')!.click();
    });
    await flush();
    await send('接着说');
    expect(harness.askQuestion).toHaveBeenCalledTimes(1);
    expect(harness.askQuestion.mock.calls[0]![0]).toMatchObject({
      conversationId: 'conv-a',
      projectId: PROJECT_A.id,
    });
  });

  it('整合方补：打开 A 的旧对话后点「新对话」，下拉框解锁；改选 B 发第一句，发出去的是 B', async () => {
    harness.createConversation.mockResolvedValue({ id: 'conv-fresh', projectId: PROJECT_A.id });
    harness.askQuestion.mockResolvedValue({ conversationId: 'conv-fresh' });
    harness.getConversation.mockImplementation(async (id: string) =>
      id === 'conv-fresh'
        ? { conversation: { id, title: '新对话', projectId: PROJECT_A.id }, messages: [] }
        : harness.getConversationDefault(id),
    );
    await render();
    await act(async () => {
      item('A 的旧对话').querySelector('button')!.click();
    });
    await flush();
    expect(select().disabled).toBe(true);
    await act(async () => {
      (document.querySelector('[data-testid="conversation-new"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(select().disabled).toBe(false);
    await act(async () => {
      setValue(select(), PROJECT_B.id);
    });
    await send('第一句');
    expect(harness.askQuestion).toHaveBeenCalledTimes(1);
    expect(harness.askQuestion.mock.calls[0]![0]).toMatchObject({
      conversationId: 'conv-fresh',
      projectId: PROJECT_B.id,
    });
  });

  it('条件 4：新对话可以选 B，发出第一句后下拉框锁定为 B', async () => {
    harness.createConversation.mockResolvedValue({ id: 'conv-new', projectId: PROJECT_B.id });
    harness.askQuestion.mockResolvedValue({ conversationId: 'conv-new' });
    harness.getConversation.mockImplementation(async (id: string) => {
      if (id === 'conv-new') {
        // 发出第一句之后，库里这个对话就有了这一轮问答（整合方补：原稿一直返回空，与真实不符）
        const asked = harness.askQuestion.mock.calls.length > 0;
        return {
          conversation: { id, title: '新对话', projectId: PROJECT_B.id },
          messages: asked
            ? [
                {
                  id: 'conv-new-m1',
                  role: 'user',
                  content: '第一句',
                  seq: 1,
                  status: 'complete',
                  meta: {},
                  citations: [],
                },
                {
                  id: 'conv-new-m2',
                  role: 'assistant',
                  content: '好的',
                  seq: 2,
                  status: 'complete',
                  meta: {},
                  citations: [],
                },
              ]
            : [],
        };
      }
      return harness.getConversationDefault(id);
    });
    await render();
    expect(select().disabled).toBe(false);
    await act(async () => {
      setValue(select(), PROJECT_B.id);
    });
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setValue(textarea, '第一句');
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(harness.askQuestion).toHaveBeenCalledTimes(1);
    const sent = harness.askQuestion.mock.calls[0]![0] as { projectId: string | null };
    expect(sent.projectId).toBe(PROJECT_B.id);
    expect(select().value).toBe(PROJECT_B.id);
    expect(select().disabled).toBe(true);
  });
});
