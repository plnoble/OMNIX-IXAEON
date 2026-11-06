// @vitest-environment jsdom
/**
 * CF6 条件 3、4（界面）：
 * 3. 搜索框输入后列表只剩匹配会话，片段里命中词加粗；清空回到原样。
 *    data-testid：conversation-search、conversation-search-snippet。
 * 4. 「已归档（N）」开关数字对；打开只显示已归档，「恢复」后回正常列表、N 减一；没有归档时不显示开关。
 *    data-testid：conversation-archived-toggle、conversation-restore-<id>。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  list: [] as Array<Record<string, unknown>>,
  archived: [] as Array<Record<string, unknown>>,
  search: [] as Array<Record<string, unknown>>,
  unarchived: [] as string[],
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
    getSettings: async () => ({
      config: {
        modelName: 'demo-a',
        chatModelName: '',
        savedModels: ['demo-a'],
        uses: {},
        fallbacks: {},
        devTools: {},
        codingChain: [],
      },
      dataDir: 'T',
    }),
    listProjects: async () => [],
    listConversations: async (input?: { includeArchived?: boolean }) =>
      input?.includeArchived ? [...h.list, ...h.archived] : h.list,
    searchConversations: async () => h.search,
    getConversation: async () => ({ conversation: { id: 'c1', title: 't' }, messages: [] }),
    unarchiveConversation: async (id: string) => {
      h.unarchived.push(id);
      const back = h.archived.find((c) => c.id === id);
      h.archived = h.archived.filter((c) => c.id !== id);
      if (back) h.list = [...h.list, { ...back, archivedAt: null }];
      return { id, title: 'x' };
    },
    listTodos: async () => [],
  },
  errMsg: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { AskPage } from '../../src/renderer/src/pages/Ask.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}
beforeEach(async () => {
  h.list = [
    {
      id: 'c1',
      title: '周报写法',
      projectId: null,
      createdAt: '',
      updatedAt: '',
      archivedAt: null,
      messageCount: 2,
      lastMessageAt: null,
      lastMessagePreview: null,
    },
    {
      id: 'c2',
      title: '买咖啡豆',
      projectId: null,
      createdAt: '',
      updatedAt: '',
      archivedAt: null,
      messageCount: 1,
      lastMessageAt: null,
      lastMessagePreview: null,
    },
  ];
  h.archived = [
    {
      id: 'a1',
      title: '旧会话',
      projectId: null,
      createdAt: '',
      updatedAt: '',
      archivedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      lastMessageAt: null,
      lastMessagePreview: null,
    },
  ];
  h.search = [];
  h.unarchived = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(AskPage, { projects: [] })));
  await settle();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function el(id: string): HTMLElement {
  const n = document.querySelector(`[data-testid="${id}"]`);
  if (!n) throw new Error('找不到 ' + id);
  return n as HTMLElement;
}
function items(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="conversation-item"]')).map((n) =>
    (n.textContent ?? '').trim(),
  );
}

describe('CF6 条件 3：搜索框与片段', () => {
  it('输入后只剩匹配会话、片段命中词加粗；清空回到原样', async () => {
    h.search = [
      {
        id: 'c1',
        title: '周报写法',
        projectId: null,
        createdAt: '',
        updatedAt: '',
        archivedAt: null,
        messageCount: 2,
        lastMessageAt: null,
        lastMessagePreview: null,
        snippet: '帮我写\u0001周报\u0002三部分',
      },
    ];
    const input = el('conversation-search') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '周报');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(items().length).toBe(1);
    const snip = el('conversation-search-snippet');
    expect(snip.querySelector('strong')?.textContent).toBe('周报');
    // 清空回到原样
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(items().length).toBe(2);
  });
});

describe('CF6 条件 4：已归档开关与恢复', () => {
  it('开关数字对；打开只显示已归档；恢复后回正常列表、N 减一', async () => {
    const toggle = el('conversation-archived-toggle');
    expect(toggle.textContent).toContain('已归档（1）');
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    const archivedItems = items().join('|');
    expect(archivedItems).toContain('旧会话');
    expect(archivedItems).not.toContain('周报写法');
    const restore = el('conversation-restore-a1');
    act(() => restore.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(h.unarchived).toEqual(['a1']);
    // 恢复后切回正常列表：它回来了，归档数变 0（没归档时不显示开关）
    if (
      (await Promise.resolve(
        document.querySelector('[data-testid="conversation-archived-toggle"]'),
      )) !== null
    ) {
      act(() =>
        el('conversation-archived-toggle').dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        ),
      );
      await settle();
    }
    expect(items().join('|')).toContain('旧会话');
    expect(document.querySelector('[data-testid="conversation-archived-toggle"]')).toBeNull();
  });

  it('没有已归档时不显示开关', async () => {
    h.archived = [];
    act(() => root?.unmount());
    document.body.innerHTML = '';
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(AskPage, { projects: [] })));
    await settle();
    expect(document.querySelector('[data-testid="conversation-archived-toggle"]')).toBeNull();
  });
});
