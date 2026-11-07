// @vitest-environment jsdom
/**
 * CF4 条件 10（界面，jsdom，替身 api）。规格 docs/委派/CF4-讨论转任务.md。
 * - complete 的助手消息下有 message-to-task-<messageId>；用户消息、failed 的助手消息下没有；
 * - 打开表单后目标框 message-to-task-goal 预填那条用户消息（默认开始 = 结束前面那条用户消息）的正文
 *   （超过 2000 字截断）；
 *   开始下拉框 message-to-task-from 的选项是这个对话里结束那条之前的全部用户消息（option value = 消息 id）；
 *   表单上写「第 a–b 条，共 n 条消息」；
 * - 验收条件 message-to-task-acceptance 为空时「建草案」message-to-task-submit 不可点；
 * - 提交时 createTaskFromConversation 收到的参数跟表单一致（验收条件按行拆、去掉空行）；
 * - 建完那条消息下出现 message-task-link-<taskId>，显示「已转成任务：<目标前 30 字>」，点了调 onOpenTask(taskId)；
 *   转过的显示数据来自 listConversationTasks（按 origin_to_seq 对上消息），不看消息 meta；
 * - 任务页卡片 task-<taskId> 里的 task-origin-<taskId> 显示「来自对话「<标题>」第 a–b 条」，点了调
 *   onOpenConversation(conversationId)；对话被删了（origin_conversation_id 为 null）显示「来自已删除的对话」；
 *   手建的任务没有 task-origin-<taskId>。
 *
 * 替补整合方 2026-11-05 锁定前改严 / 补：
 * - 原测试在不挪开始的情况下断言目标是第 1 轮的问题，跟规格「开始默认是它前面那条用户消息」相反，改正；
 * - 原测试对话是个人视角又不给项目，按规格根本提交不了；改成项目对话，另加个人视角要选项目
 *   （message-to-task-project）才能提交；
 * - 补任务页来源一项。testid 定为 task-origin-<taskId>，放在任务卡片 task-<taskId>（Tasks.tsx 现有的 Card）里；
 *   TasksPage 新加可选属性 onOpenConversation(conversationId)，App 里接 setOpenConversationId 并切到聊天页。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const P1 = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  tasks: [] as Array<Record<string, unknown>>,
  listTasksCalls: [] as string[],
  conversationProjectId: null as string | null,
  codingTasks: [] as Array<Record<string, unknown>>,
}));

const now = '2026-11-05T00:00:00.000Z';
const conversationRow = (id: string, title: string) => ({
  id,
  title,
  projectId: h.conversationProjectId,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  engine: null,
  engineSessionId: null,
  sourceId: null,
  messageCount: 4,
  lastMessageAt: null,
  lastMessagePreview: null,
});

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
    listConversations: async () => [conversationRow('c1', '记账讨论')],
    listTodos: async () => [],
    getSettings: async () => ({
      config: { modelName: 'demo-a', savedModels: [], uses: {}, fallbacks: {}, codingChain: [] },
    }),
    getConversation: async (id: string) => ({
      conversation: conversationRow(id, '记账讨论'),
      messages: h.messages,
    }),
    listConversationTasks: async (conversationId: string) => {
      h.listTasksCalls.push(conversationId);
      return h.tasks;
    },
    createTaskFromConversation: async (input: Record<string, unknown>) => {
      h.created.push(input);
      const from = h.messages.find((m) => m['id'] === input['fromMessageId']);
      const to = h.messages.find((m) => m['id'] === input['toMessageId']);
      const task = {
        id: 'task-new',
        goal: input['goal'],
        status: 'draft',
        project_id: P1,
        origin_conversation_id: 'c1',
        origin_from_seq: from?.['seq'] ?? null,
        origin_to_seq: to?.['seq'] ?? null,
      };
      h.tasks.push(task);
      return task;
    },
    // 任务页
    listCodingTasks: async () => ({
      executor: 'fake',
      realDispatchEnabled: false,
      notice: '合成说明',
      tasks: h.codingTasks,
    }),
    listSkillCandidates: async () => [],
    getCodingTaskChanges: async () => ({ files: [] }),
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';
import { TasksPage } from '../../src/renderer/src/pages/Tasks.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let opened: string[] = [];
let openedConversations: string[] = [];

const projects = [
  {
    id: P1,
    name: '合成项目甲',
    root_path: 'T',
    description: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  },
];

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function msg(id: string, seq: number, role: string, content: string, status = 'complete') {
  return {
    id,
    conversationId: 'c1',
    seq,
    role,
    content,
    status,
    createdAt: now,
    updatedAt: now,
    runId: null,
    engine: null,
    modelName: null,
    citations: [],
    meta: {},
    errorMessage: status === 'failed' ? '合成失败' : null,
  };
}

async function mountAsk(): Promise<void> {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(AskPage, {
        projects: projects as never,
        openConversationId: 'c1',
        onOpenTask: (id: string) => opened.push(id),
      }),
    ),
  );
  await settle();
}

beforeEach(() => {
  h.created = [];
  h.tasks = [];
  h.listTasksCalls = [];
  h.codingTasks = [];
  h.conversationProjectId = P1;
  opened = [];
  openedConversations = [];
  h.messages = [
    msg('m1', 1, 'user', '帮我想想记账小程序要哪些页面'),
    msg('m2', 2, 'assistant', '先做记一笔和列表'),
    msg('m3', 3, 'user', '那先做记一笔这页'),
    msg('m4', 4, 'assistant', '好，记一笔这页要有金额和备注'),
  ];
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
const click = (node: HTMLElement) =>
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
function typeInto(node: HTMLElement, value: string): void {
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
/** 某个 testid 的元素落在哪条消息（message-item）里。 */
const messageOf = (node: HTMLElement): string | null =>
  (node.closest('[data-testid="message-item"]') as HTMLElement | null)?.textContent ?? null;

describe('CF4 条件 10：按钮出现的位置', () => {
  it('complete 助手消息下有；用户消息、failed 助手消息下没有', async () => {
    h.messages[3] = msg('m4', 4, 'assistant', '合成的半截回答', 'failed');
    await mountAsk();
    const m2 = maybe('message-to-task-m2');
    expect(m2).toBeTruthy();
    expect(messageOf(m2!)).toContain('先做记一笔和列表');
    expect(maybe('message-to-task-m1')).toBeNull();
    expect(maybe('message-to-task-m3')).toBeNull();
    expect(maybe('message-to-task-m4')).toBeNull();
  });

  it('streaming 的助手消息下也没有', async () => {
    h.messages[3] = msg('m4', 4, 'assistant', '', 'streaming');
    await mountAsk();
    expect(maybe('message-to-task-m4')).toBeNull();
  });
});

describe('CF4 条件 10：表单与提交', () => {
  it('默认就这一轮；开始下拉是结束之前的全部用户消息；空验收不能提交；提交参数跟表单一致；建完出现链接', async () => {
    await mountAsk();
    expect(maybe('message-to-task-goal')).toBeNull(); // 没点之前不展开
    click(el('message-to-task-m4'));
    await settle();
    const goal = el('message-to-task-goal') as HTMLTextAreaElement | HTMLInputElement;
    // 表单就在这条消息下面展开
    expect(messageOf(goal)).toContain('好，记一笔这页要有金额和备注');
    // 默认开始 = m4 前面那条用户消息 m3，目标预填它的正文
    expect(goal.value).toBe('那先做记一笔这页');
    const from = el('message-to-task-from') as HTMLSelectElement;
    expect(Array.from(from.options).map((o) => o.value)).toEqual(['m1', 'm3']);
    expect(from.value).toBe('m3');
    expect(document.body.textContent).toContain('第 3–4 条');

    const submit = () => el('message-to-task-submit') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    // 只有空白行也算空
    typeInto(el('message-to-task-acceptance'), '  \n\n');
    await settle();
    expect(submit().disabled).toBe(true);

    // 开始往前挪到第 1 条
    typeInto(from, 'm1');
    await settle();
    expect(document.body.textContent).toContain('第 1–4 条，共 4 条消息');

    typeInto(el('message-to-task-goal'), '合成目标：先做记一笔这页');
    typeInto(el('message-to-task-acceptance'), '记一笔能保存\n\n  \n账目能列出\n');
    await settle();
    expect(submit().disabled).toBe(false);
    expect(h.created.length).toBe(0); // 不点不建
    click(submit());
    await settle();

    expect(h.created.length).toBe(1);
    const sent = h.created[0]!;
    expect(sent).toMatchObject({
      conversationId: 'c1',
      fromMessageId: 'm1',
      toMessageId: 'm4',
      goal: '合成目标：先做记一笔这页',
      acceptance: ['记一笔能保存', '账目能列出'],
    });
    // 范围不传就是 ['.']；传了也只能是 ['.']（表单默认）
    if (sent['scope'] !== undefined) expect(sent['scope']).toEqual(['.']);
    // 对话有项目时不靠界面传项目；传了也只能是对话的项目
    if (sent['projectId'] !== undefined) expect(sent['projectId']).toBe(P1);

    const link = el('message-task-link-task-new');
    expect(messageOf(link)).toContain('好，记一笔这页要有金额和备注');
    expect(document.body.textContent).toContain('已转成任务：合成目标：先做记一笔这页');
    click(link.querySelector('button') ?? link);
    expect(opened).toEqual(['task-new']);
  });

  it('结束在第 2 条时，开始下拉只有它之前的用户消息（不含后面的 m3），目标预填 m1', async () => {
    await mountAsk();
    click(el('message-to-task-m2'));
    await settle();
    const from = el('message-to-task-from') as HTMLSelectElement;
    expect(Array.from(from.options).map((o) => o.value)).toEqual(['m1']);
    expect((el('message-to-task-goal') as HTMLTextAreaElement).value).toBe(
      '帮我想想记账小程序要哪些页面',
    );
    expect(document.body.textContent).toContain('第 1–2 条，共 2 条消息');
  });

  it('用户消息超过 2000 字时目标框预填前 2000 字', async () => {
    h.messages[2] = msg('m3', 3, 'user', '戊'.repeat(2500));
    await mountAsk();
    click(el('message-to-task-m4'));
    await settle();
    expect((el('message-to-task-goal') as HTMLTextAreaElement).value).toBe('戊'.repeat(2000));
  });

  it('目标超过 30 字时链接只显示前 30 字', async () => {
    h.tasks = [
      {
        id: 'task-long',
        goal: '甲乙丙丁戊己庚辛壬癸'.repeat(4),
        status: 'draft',
        origin_conversation_id: 'c1',
        origin_from_seq: 1,
        origin_to_seq: 4,
      },
    ];
    await mountAsk();
    const text = document.body.textContent ?? '';
    expect(text).toContain('已转成任务：' + '甲乙丙丁戊己庚辛壬癸'.repeat(3));
    expect(text).not.toContain('甲乙丙丁戊己庚辛壬癸'.repeat(4));
  });

  it('转过的从 listConversationTasks 读出来，挂在 origin_to_seq 那条消息下', async () => {
    h.tasks = [
      {
        id: 'task-old',
        goal: '早先转出的合成任务',
        status: 'draft',
        origin_conversation_id: 'c1',
        origin_from_seq: 1,
        origin_to_seq: 2,
      },
    ];
    await mountAsk();
    expect(h.listTasksCalls).toContain('c1');
    const link = el('message-task-link-task-old');
    expect(messageOf(link)).toContain('先做记一笔和列表');
    expect(messageOf(link)).not.toContain('好，记一笔这页要有金额和备注');
    click(link.querySelector('button') ?? link);
    expect(opened).toEqual(['task-old']);
  });

  it('个人视角的对话：没选项目不能提交，选了项目甲提交带上它', async () => {
    h.conversationProjectId = null;
    await mountAsk();
    click(el('message-to-task-m4'));
    await settle();
    typeInto(el('message-to-task-acceptance'), '记一笔能保存');
    await settle();
    const submit = () => el('message-to-task-submit') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    typeInto(el('message-to-task-project'), P1);
    await settle();
    expect(submit().disabled).toBe(false);
    click(submit());
    await settle();
    expect(h.created.length).toBe(1);
    expect(h.created[0]).toMatchObject({ projectId: P1, toMessageId: 'm4', fromMessageId: 'm3' });
  });
});

describe('CF4 条件 10：任务页看得到来源', () => {
  function codingTask(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    return {
      id,
      project_id: P1,
      goal: `合成任务 ${id}`,
      scope_json: '["."]',
      workspace_path: null,
      snapshot_ref: null,
      context_digest: 'd',
      allowed_commands_json: '[]',
      timeout_ms: 1000,
      status: 'draft',
      version: 1,
      approval_id: null,
      dispatch_key: null,
      generation: 0,
      executor_name: null,
      executor_report_json: null,
      verify_status: null,
      verify_exit_code: null,
      verify_output: null,
      tests_modified: false,
      accepted_at: null,
      error: null,
      created_at: now,
      updated_at: now,
      acceptance_json: '[]',
      applied_ref: null,
      applied_at: null,
      apply_error: null,
      origin_conversation_id: null,
      origin_from_seq: null,
      origin_to_seq: null,
      ...patch,
    };
  }

  it('来源对话还在：「来自对话「标题」第 a–b 条」，点了打开对话；删了：「来自已删除的对话」；手建的没有', async () => {
    h.codingTasks = [
      codingTask('t-conv', { origin_conversation_id: 'c1', origin_from_seq: 1, origin_to_seq: 4 }),
      codingTask('t-gone', { origin_conversation_id: null, origin_from_seq: 3, origin_to_seq: 4 }),
      codingTask('t-hand', {}),
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        createElement(TasksPage, {
          projects: projects as never,
          onOpenConversation: (id: string) => openedConversations.push(id),
        } as never),
      ),
    );
    await settle();

    const origin = el('task-origin-t-conv');
    expect(origin.closest('[data-testid="task-t-conv"]')).toBeTruthy();
    expect(origin.textContent).toContain('来自对话「记账讨论」第 1–4 条');
    click((origin.querySelector('button, a') as HTMLElement | null) ?? origin);
    expect(openedConversations).toEqual(['c1']);

    const gone = el('task-origin-t-gone');
    expect(gone.closest('[data-testid="task-t-gone"]')).toBeTruthy();
    expect(gone.textContent).toContain('来自已删除的对话');
    expect(gone.textContent).not.toContain('记账讨论');

    expect(maybe('task-t-hand')).toBeTruthy();
    expect(maybe('task-origin-t-hand')).toBeNull();
  });
});
