// @vitest-environment jsdom
/**
 * CF0 验收（聊天页，规格 docs/委派/CF0-聊天先能用.md）
 *
 * 逐条对应规格「验收条件」：
 * - 条件 4：一条消息以「没有可用渠道」失败、已保存模型有 demo-a（失败的）、demo-b、demo-c
 *   → 失败消息下面出现下拉框，选项正好是 demo-b、demo-c。
 * - 条件 5：选 demo-b 点「用这个模型重问」→ 聊天模型设置变成 demo-b；同一个对话里多出一问一答，
 *   问的是原话；失败的那条还在、状态还是 failed。
 * - 条件 6：已保存的模型只有失败的那个 → 不出下拉框，出「设置里还没有别的可用模型」和跳设置的按钮。
 * - 条件 7：失败原因是超时或 429 → 不出这个控件。
 *
 * 钉住的接缝（实现必须兼容）：
 * - 失败控件在回答消息（AskMessage）里，靠 `isModelUnavailable(消息的 errorMessage)` 判定；
 * - 聊天页从 `api.getSettings()` 读 `config.modelName` / `config.savedModels` / `config.chatModelName`；
 * - 重问 = 先走现有保存设置的 `api.saveModelSettings({ modelName, chatModelName })`（`modelName`
 *   原样带回、只改聊天模型），再走和输入框发送同一条 `api.askQuestion` 路径，
 *   `conversationId` 是当前对话，`question` 是失败回答前面那条用户消息的原话。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEMO_FAILURE =
  '网关里「demo-a」现在没有可用渠道（常见原因是那条渠道的套餐或额度失效了）。' +
  '去网关后台给它补一条渠道，或者在聊天里换一个模型重问。' +
  '（原始错误：HTTP 503: No available channel for model demo-a under group default (distributor)）';

const harness = vi.hoisted(() => {
  const state = {
    failure: '',
    saved: [] as string[],
    chatModel: '',
    analysisModel: 'demo-a',
    asked: 0,
    question: '原话问题',
  };

  const message = (input: {
    id: string;
    seq: number;
    role: 'user' | 'assistant';
    content: string;
    status: string;
    modelName?: string | null;
    errorMessage?: string | null;
  }) => ({
    id: input.id,
    conversationId: 'conv-1',
    seq: input.seq,
    role: input.role,
    content: input.content,
    status: input.status,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    runId: null,
    engine: input.role === 'assistant' ? 'hermes' : null,
    modelName: input.modelName ?? null,
    citations: [],
    meta: {},
    errorMessage: input.errorMessage ?? null,
  });

  const getConversation = vi.fn(async (id: string) => {
    const messages = [
      message({
        id: 'm1',
        seq: 1,
        role: 'user',
        content: state.question,
        status: 'complete',
      }),
      message({
        id: 'm2',
        seq: 2,
        role: 'assistant',
        content: '',
        status: 'failed',
        modelName: 'demo-a',
        errorMessage: state.failure,
      }),
    ];
    // 重问之后：同一个对话里多出一问一答（失败的那条照旧留着）
    if (state.asked > 0) {
      messages.push(
        message({
          id: 'm3',
          seq: 3,
          role: 'user',
          content: state.question,
          status: 'complete',
        }),
        message({
          id: 'm4',
          seq: 4,
          role: 'assistant',
          content: '这次答出来了',
          status: 'complete',
          modelName: 'demo-b',
        }),
      );
    }
    return {
      conversation: {
        id,
        title: '合成对话',
        projectId: null,
        createdAt: '2026-10-31T00:00:00.000Z',
        updatedAt: '2026-10-31T00:00:00.000Z',
        archivedAt: null,
        engine: 'hermes',
        engineSessionId: null,
        sourceId: null,
      },
      messages,
    };
  });

  return {
    state,
    listConversations: vi.fn(async () => [
      {
        id: 'conv-1',
        title: '合成对话',
        projectId: null,
        createdAt: '2026-10-31T00:00:00.000Z',
        updatedAt: '2026-10-31T00:00:00.000Z',
        archivedAt: null,
        engine: 'hermes',
        engineSessionId: null,
        sourceId: null,
        messageCount: 2,
        lastMessageAt: '2026-10-31T00:00:00.000Z',
        lastMessagePreview: '原话问题',
      },
    ]),
    getConversation,
    getSettings: vi.fn(async () => ({
      config: {
        modelName: state.analysisModel,
        chatModelName: state.chatModel,
        savedModels: [...state.saved],
      },
    })),
    saveModelSettings: vi.fn(async (input: { modelName: string; chatModelName?: string }) => {
      state.analysisModel = input.modelName;
      if (input.chatModelName !== undefined) state.chatModel = input.chatModelName;
      return { ok: true as const, keyCleared: false };
    }),
    askQuestion: vi.fn(async (input: { conversationId: string; question: string }) => {
      state.asked += 1;
      return { conversationId: input.conversationId };
    }),
    listTodos: vi.fn(async () => []),
    onAskProgress: vi.fn(() => () => undefined),
    onAskDelta: vi.fn(() => () => undefined),
    prewarmChat: vi.fn(async () => ({ warmed: false })),
    cancelAsk: vi.fn(async () => ({ cancelled: false, runId: null })),
  };
});

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listConversations: harness.listConversations,
    getConversation: harness.getConversation,
    getSettings: harness.getSettings,
    saveModelSettings: harness.saveModelSettings,
    askQuestion: harness.askQuestion,
    listTodos: harness.listTodos,
    onAskProgress: harness.onAskProgress,
    onAskDelta: harness.onAskDelta,
    prewarmChat: harness.prewarmChat,
    cancelAsk: harness.cancelAsk,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';

let root: Root;
let host: HTMLDivElement;
const onOpenModelSettings = vi.fn();

beforeEach(() => {
  harness.state.failure = DEMO_FAILURE;
  harness.state.saved = ['demo-a', 'demo-b', 'demo-c'];
  harness.state.chatModel = 'demo-a';
  harness.state.analysisModel = 'demo-a';
  harness.state.asked = 0;
  harness.getConversation.mockClear();
  harness.getSettings.mockClear();
  harness.saveModelSettings.mockClear();
  harness.askQuestion.mockClear();
  onOpenModelSettings.mockClear();
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
    root.render(
      createElement(AskPage, {
        projects: [],
        openConversationId: 'conv-1',
        onOpenModelSettings,
      }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const $ = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);

function retrySelect(): HTMLSelectElement {
  const el = $('model-retry-select');
  if (!el) throw new Error('没有「换个模型重问」的下拉框');
  return el as HTMLSelectElement;
}

function setSelectValue(el: HTMLSelectElement, value: string): void {
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  proto!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function click(testId: string): Promise<void> {
  const el = $(testId);
  if (!el) throw new Error(`没有 ${testId}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('CF0 在聊天里换个已保存的模型重问（聊天页）', () => {
  it('条件 4：没渠道失败下面出现下拉框，选项正好是 demo-b、demo-c（不算失败的那个）', async () => {
    await render();
    const failed = document.querySelector('[data-status="failed"]');
    expect(failed).not.toBeNull();
    const select = retrySelect();
    // 控件就在失败的那条消息下面
    expect(failed!.contains(select)).toBe(true);
    expect([...select.options].map((o) => o.value)).toEqual(['demo-b', 'demo-c']);
  });

  it('条件 5：选 demo-b 重问 → 设置改成 demo-b、同一个对话多一问一答、失败的那条还在', async () => {
    await render();
    const select = retrySelect();
    await act(async () => setSelectValue(select, 'demo-b'));
    await click('model-retry-run');

    expect(harness.saveModelSettings).toHaveBeenCalledTimes(1);
    expect(harness.saveModelSettings).toHaveBeenCalledWith({
      modelName: 'demo-a',
      chatModelName: 'demo-b',
    });
    // 规格：先改聊天模型，再重问（不是先问、再改）
    expect(harness.saveModelSettings.mock.invocationCallOrder[0]).toBeLessThan(
      harness.askQuestion.mock.invocationCallOrder[0]!,
    );
    expect(harness.askQuestion).toHaveBeenCalledTimes(1);
    expect(harness.askQuestion.mock.calls[0]![0]).toMatchObject({
      conversationId: 'conv-1',
      projectId: null,
      question: '原话问题',
    });

    expect(harness.state.chatModel).toBe('demo-b');
    expect(harness.state.analysisModel).toBe('demo-a');
    // 失败的那条照旧留着、状态还是 failed
    const failed = document.querySelector('[data-status="failed"]');
    expect(failed).not.toBeNull();
    expect(failed!.textContent).toContain('没有可用渠道');
    // 同一个对话里多出了这一轮的回答
    expect(document.querySelector('[data-testid="message-list"]')!.textContent).toContain(
      '这次答出来了',
    );
  });

  it('条件 6：只有失败的那个已保存 → 不出下拉框，出提示和去设置的按钮', async () => {
    harness.state.saved = ['demo-a'];
    await render();
    expect($('model-retry-select')).toBeNull();
    expect($('model-unavailable-hint')!.textContent).toContain('设置里还没有别的可用模型');
    await click('model-unavailable-settings');
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
  });

  it('条件 7：超时失败不出这个控件', async () => {
    harness.state.failure =
      '模型太久没有回应。推理型模型（先「思考」再回答）会慢很多，可以在「设置 → 模型接入 → 聊天模型」换一个快一点的。' +
      '（原始错误：请求超时 timeout）';
    await render();
    expect($('model-retry-select')).toBeNull();
    expect($('model-unavailable-hint')).toBeNull();
    expect($('model-unavailable-settings')).toBeNull();
  });

  it('条件 7：429 失败不出这个控件', async () => {
    harness.state.failure =
      '模型网关同时处理的请求数到上限了——常见原因是后台分析正占着同一个账号。' +
      '（原始错误：HTTP 429: Too Many Requests）';
    await render();
    expect($('model-retry-select')).toBeNull();
    expect($('model-unavailable-hint')).toBeNull();
    expect($('model-unavailable-settings')).toBeNull();
  });
});
