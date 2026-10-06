// @vitest-environment jsdom
/**
 * U3 验收（规格 docs/委派/U3-任务页看改动.md 条件 12）：任务卡片里的「看改动」。
 * - 执行报告里 changedPaths 非空的任务显示「改了 N 个文件」和「看改动」按钮；
 * - 点开列出每个文件的路径、种类、note、差异；+/- 行颜色不同；
 * - 按钮变「收起」，再点收起；再点开重新读一次；
 * - 读取出错显示在这张卡片里，不上页顶报错条；
 * - 清单空、没有执行报告的任务不显示这一行。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingTask, TaskChanges } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  rows: [] as CodingTask[],
  changes: null as TaskChanges | null,
  changesCalls: [] as string[],
  changesError: null as string | null,
  listCodingTasks: vi.fn(),
  listSkillCandidates: vi.fn(async () => []),
  getCodingTaskChanges: vi.fn(),
  hasToggle: null as (() => boolean) | null,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listCodingTasks: harness.listCodingTasks,
    listSkillCandidates: harness.listSkillCandidates,
    getCodingTaskChanges: harness.getCodingTaskChanges,
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { TasksPage } from '../../src/renderer/src/pages/Tasks.js';

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

beforeEach(() => {
  harness.listCodingTasks.mockClear();
  harness.listSkillCandidates.mockClear();
  harness.getCodingTaskChanges.mockClear();
  harness.changesCalls = [];
  harness.changesError = null;
  harness.changes = null;
  harness.getCodingTaskChanges.mockImplementation(async (id: string) => {
    harness.changesCalls.push(id);
    if (harness.changesError) throw new Error(harness.changesError);
    return harness.changes;
  });
  harness.rows = [
    task('rich', { executor_report_json: report(['note.txt', 'new.txt', 'secret.pem']) }),
    task('empty', { executor_report_json: report([]) }),
    task('noreport', { executor_report_json: null }),
  ];
  harness.listCodingTasks.mockImplementation(async () => ({
    executor: 'fake',
    realDispatchEnabled: false,
    notice: '合成说明',
    tasks: harness.rows,
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
    root.render(createElement(TasksPage, { projects: [] }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('U3 任务卡片看改动（条件 12）', () => {
  it('有改动的任务显示「改了 N 个文件」和「看改动」，点开列出文件、种类、note、差异与颜色', async () => {
    harness.changes = {
      total: 3,
      files: [
        {
          path: 'note.txt',
          kind: 'modified',
          diff: '+新加的第三行\n-第二行\n 上下文行',
          note: null,
        },
        { path: 'new.txt', kind: 'added', diff: '+新增内容\n', note: null },
        { path: 'secret.pem', kind: 'unknown', diff: null, note: '密钥类文件，不显示内容' },
      ],
    };
    await render();

    const card = $('task-rich')!.textContent!;
    expect(card).toContain('改了 3 个文件');
    const toggle = $('task-changes-toggle-rich');
    expect(toggle).toBeTruthy();
    expect(toggle!.textContent).toContain('看改动');
    // 没点开之前不渲染清单
    expect($('task-changes-rich')).toBeNull();

    await click(toggle!);
    expect(harness.changesCalls).toEqual(['rich']);
    const openBox = $('task-changes-rich')!;
    expect(openBox).toBeTruthy();
    const text = openBox.textContent!;
    expect(text).toContain('note.txt');
    expect(text).toContain('修改');
    expect(text).toContain('new.txt');
    expect(text).toContain('新增');
    expect(text).toContain('secret.pem');
    expect(text).toContain('看不了');
    expect(text).toContain('密钥类文件，不显示内容');
    // 差异正文：+ 行绿色、- 行红色
    const addLine = Array.from(openBox.querySelectorAll('.diff-add')).find((el) =>
      (el.textContent ?? '').includes('新加的第三行'),
    );
    expect(addLine).toBeTruthy();
    const delLine = Array.from(openBox.querySelectorAll('.diff-del')).find((el) =>
      (el.textContent ?? '').includes('第二行'),
    );
    expect(delLine).toBeTruthy();
    // 按钮变成「收起」
    expect(toggle!.textContent).toContain('收起');

    // 再点收起：清单没了，不重新读
    await click(toggle!);
    expect($('task-changes-rich')).toBeNull();
    expect(toggle!.textContent).toContain('看改动');
    expect(harness.changesCalls).toEqual(['rich']);

    // 再点开：重新读一次
    await click(toggle!);
    expect(harness.changesCalls).toEqual(['rich', 'rich']);
    expect($('task-changes-rich')).toBeTruthy();
  });

  it('收起再展开：旧请求的失败/结果不会盖掉新请求', async () => {
    const good: TaskChanges = {
      total: 1,
      files: [{ path: 'note.txt', kind: 'modified', diff: '+a\n-b\n', note: null }],
    };
    let resolveNew: ((v: TaskChanges) => void) | null = null;
    let callNo = 0;
    harness.getCodingTaskChanges.mockImplementation((_id: string) => {
      callNo += 1;
      if (callNo === 1) {
        // 旧请求：晚些时候失败
        return new Promise<TaskChanges>((_res, rej) => {
          setTimeout(() => rej(new Error('IXA0001 旧请求失败')), 30);
        });
      }
      return new Promise<TaskChanges>((res) => {
        resolveNew = res;
      });
    });
    await render();
    const toggle = $('task-changes-toggle-rich')!;
    await click(toggle); // 请求 1
    await click(toggle); // 收起
    await click(toggle); // 再展开 → 请求 2（挂起）
    // 让旧请求的失败先落地：不该显示任何错误
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect($('task-changes-error-rich')).toBeNull();
    // 新请求成功：清单正常显示
    await act(async () => {
      resolveNew!(good);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect($('task-changes-error-rich')).toBeNull();
    const boxText = $('task-changes-rich')!.textContent!;
    expect(boxText).toContain('note.txt');
    expect(boxText).not.toContain('旧请求失败');
  });

  // 整合方复审时补：上一条只照了「旧请求晚到的失败」，旧请求晚到的结果没照
  it('收起再展开：旧请求晚到的结果不会盖掉新请求的结果', async () => {
    const stale: TaskChanges = {
      total: 1,
      files: [{ path: 'old.txt', kind: 'modified', diff: '+旧的', note: null }],
    };
    const fresh: TaskChanges = {
      total: 1,
      files: [{ path: 'fresh.txt', kind: 'modified', diff: '+新的', note: null }],
    };
    const resolvers: Array<(v: TaskChanges) => void> = [];
    harness.getCodingTaskChanges.mockImplementation(
      () =>
        new Promise<TaskChanges>((res) => {
          resolvers.push(res);
        }),
    );
    await render();
    const toggle = $('task-changes-toggle-rich')!;
    await click(toggle); // 请求 1（挂着）
    await click(toggle); // 收起
    await click(toggle); // 再展开 → 请求 2（挂着）
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[1]!(fresh);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect($('task-changes-rich')!.textContent).toContain('fresh.txt');
    // 旧请求这时才回来：不许把新结果换掉
    await act(async () => {
      resolvers[0]!(stale);
      await Promise.resolve();
      await Promise.resolve();
    });
    const text = $('task-changes-rich')!.textContent!;
    expect(text).toContain('fresh.txt');
    expect(text).not.toContain('old.txt');
  });

  it('total 比列出来的多时写「共 N 个，只列了前 50 个」', async () => {
    harness.changes = {
      total: 60,
      files: [{ path: 'f1.txt', kind: 'modified', diff: '+a\n-b\n', note: null }],
    };
    await render();
    await click($('task-changes-toggle-rich')!);
    const text = $('task-changes-rich')!.textContent!;
    expect(text).toContain('共 60 个，只列了前 50 个');
    expect(text).toContain('f1.txt');
  });

  it('读取出错显示在这张卡片里，不上页顶报错条', async () => {
    harness.changesError = 'IXA0404 编码任务不存在: rich';
    await render();
    await click($('task-changes-toggle-rich')!);
    const box = $('task-changes-rich')!;
    expect(box).toBeTruthy();
    const err = $('task-changes-error-rich')!;
    expect(err.textContent).toContain('编码任务不存在');
    expect($('error-banner')).toBeNull();
  });

  it('没有改动清单、没有执行报告的任务不显示这一行和按钮', async () => {
    await render();
    expect($('task-changes-toggle-empty')).toBeNull();
    expect($('task-changes-toggle-noreport')).toBeNull();
    expect($('task-empty')!.textContent).not.toContain('看改动');
    expect($('task-noreport')!.textContent).not.toContain('看改动');
  });
});
