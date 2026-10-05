// @vitest-environment jsdom
/**
 * U2 验收：任务页自己跟上任务的状态。
 *
 * 来由（用户 2026-10-05 试场景一）：聊天里点「要做」，任务在后台跑了三分多钟做完了，
 * 任务页却一直停在「执行中」——这一页只在打开时和点按钮之后读一次。用户以为卡住了。
 *
 * 条件：
 * 1. 页面上有任务在排队、执行或验证时，不用点任何东西，任务做完后卡片自己变成新的状态。
 * 2. 自己刷新只更新任务，不把用户正在看的报错条清掉。
 * 3. 没有在跑的任务时不反复去读。
 * 4. 离开页面后不再读。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingTask } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: { rows: CodingTask[]; listCalls: number; failApprove: boolean } = {
  rows: [],
  listCalls: 0,
  failApprove: false,
};

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listCodingTasks: async () => {
      state.listCalls += 1;
      return {
        executor: 'fake',
        realDispatchEnabled: false,
        notice: '合成说明',
        tasks: state.rows,
      };
    },
    listSkillCandidates: async () => [],
    approveCodingTask: async () => {
      if (state.failApprove) throw new Error('合成的报错');
      return state.rows[0];
    },
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { TasksPage } from '../../src/renderer/src/pages/Tasks.js';

let container: HTMLDivElement;
let root: Root;

function task(id: string, status: string): CodingTask {
  return {
    id,
    goal: `合成任务 ${id}`,
    status,
    version: 1,
    executor_name: 'codex-cli',
  } as unknown as CodingTask;
}

beforeEach(() => {
  vi.useFakeTimers();
  state.rows = [];
  state.listCalls = 0;
  state.failApprove = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(TasksPage, { projects: [] }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** 过一段时间（让定时器和它引出的读取都跑完）。 */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const card = (id: string) =>
  container.querySelector(`[data-testid="task-${id}"]`)?.textContent ?? '';

describe('U2 任务页自己跟上任务的状态', () => {
  for (const status of ['queued', 'running', 'pending_verify']) {
    it(`条件 1：任务（${status}）在后台做完了，卡片不用点就变成「待用户接受」`, async () => {
      state.rows = [task('a', status)];
      await render();
      expect(card('a')).not.toContain('待用户接受');
      // 后台做完了；用户什么都没点
      state.rows = [task('a', 'pending_accept')];
      await pass(5000);
      expect(card('a')).toContain('待用户接受');
    });
  }

  it('条件 2：自己刷新不清掉用户正在看的报错条', async () => {
    state.rows = [task('w', 'waiting_approval'), task('r', 'running')];
    state.failApprove = true;
    await render();
    const approve = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('批准并排队'),
    )!;
    await act(async () => {
      approve.click();
    });
    await pass(0);
    expect(container.textContent).toContain('合成的报错');
    await pass(5000);
    expect(container.textContent, '报错条还在').toContain('合成的报错');
  });

  it('条件 3：没有在跑的任务时不反复去读', async () => {
    state.rows = [task('a', 'pending_accept'), task('b', 'completed'), task('c', 'failed')];
    await render();
    const after = state.listCalls;
    await pass(20_000);
    expect(state.listCalls).toBe(after);
  });

  it('条件 3：任务做完之后就停下，不再读', async () => {
    state.rows = [task('a', 'running')];
    await render();
    state.rows = [task('a', 'pending_accept')];
    await pass(5000);
    expect(card('a')).toContain('待用户接受');
    const after = state.listCalls;
    await pass(20_000);
    expect(state.listCalls).toBe(after);
  });

  it('条件 4：离开页面后不再读', async () => {
    state.rows = [task('a', 'running')];
    await render();
    act(() => root.unmount());
    const after = state.listCalls;
    await pass(20_000);
    expect(state.listCalls).toBe(after);
    root = createRoot(container);
  });
});
