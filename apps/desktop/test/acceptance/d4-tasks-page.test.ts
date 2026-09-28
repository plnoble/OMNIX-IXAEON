// @vitest-environment jsdom
/**
 * D4 验收（规格 docs/委派/D4-接受后在项目里建分支.md 契约 6）：任务页同样显示落地结果。
 * - 建了分支：显示分支名，写明没有推送（怎么合由用户定）。
 * - 改动包：显示位置和原因。
 * - 没落地（授权没过等）：显示 apply_error 的原因。
 * - 没有改动：如实写「没有改动」。
 * 页面拿数据走 api.listCodingTasks()（就是 IPC → store.list() 那条链），这里替身掉 api。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingTask } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  rows: [] as CodingTask[],
  listCodingTasks: vi.fn(),
  listSkillCandidates: vi.fn(async () => []),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listCodingTasks: harness.listCodingTasks,
    listSkillCandidates: harness.listSkillCandidates,
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
    status: 'completed',
    version: 1,
    ...patch,
  } as unknown as CodingTask;
}

beforeEach(() => {
  harness.listCodingTasks.mockClear();
  harness.listSkillCandidates.mockClear();
  harness.rows = [
    // 建了分支：显示分支名与「没有推送」
    task('landed', { applied_ref: 'ixaeon/abcd1234' }),
    // 改动包：显示位置与原因
    task('patched', {
      applied_ref: 'D:\\data\\patches\\patched',
      apply_error: '项目不是 git 仓库',
    }),
    // 授权没过：不落地，显示原因
    task('denied', { apply_error: '没有这个项目目录的读取授权' }),
    // 没有改动：执行报告里确实没有任何改动路径，如实写
    task('nothing', {
      executor_report_json:
        '{"claimedSuccess":true,"summary":"没改文件","changedPaths":[],"testsModified":false,"raw":""}',
    }),
    // 有改动但没落地（旧版本完成、改动还在副本里）：不能当成「没有改动」
    task('stuck', {
      executor_report_json:
        '{"claimedSuccess":true,"summary":"改了","changedPaths":["note.txt"],"testsModified":false,"raw":""}',
    }),
  ];
  harness.listCodingTasks.mockImplementation(async () => ({
    notice: '合成说明',
    realDispatchEnabled: false,
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

describe('任务页显示落地结果（契约 6）', () => {
  it('建了分支的任务：卡片上显示分支名、没推送、没动工作区、怎么合并', async () => {
    await render();
    const card = $('task-landed')?.textContent ?? '';
    expect(card).toContain('ixaeon/abcd1234');
    expect(card).toContain('没有推送');
    expect(card).toContain('没动你的工作区');
    expect(card).toContain('git merge ixaeon/abcd1234');
  });

  it('改动包的任务：卡片上显示位置和原因', async () => {
    await render();
    const card = $('task-patched')?.textContent ?? '';
    expect(card).toContain('改动包');
    expect(card).toContain('D:\\data\\patches\\patched');
    expect(card).toContain('项目不是 git 仓库');
  });

  it('授权没过的任务：卡片上显示不落地的原因', async () => {
    await render();
    const card = $('task-denied')?.textContent ?? '';
    expect(card).toContain('没有这个项目目录的读取授权');
  });

  it('没有改动的任务：卡片上如实写「没有改动」', async () => {
    await render();
    const card = $('task-nothing')?.textContent ?? '';
    expect(card).toContain('没有改动');
  });

  it('有改动但没落地的任务：不能当成「没有改动」', async () => {
    await render();
    const card = $('task-stuck')?.textContent ?? '';
    expect(card).not.toContain('没有改动');
  });
});
