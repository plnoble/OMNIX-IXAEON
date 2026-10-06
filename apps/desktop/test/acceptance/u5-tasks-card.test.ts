// @vitest-environment jsdom
/**
 * U5 验收（规格 docs/委派/U5-任务卡片说人话.md）的卡片：
 * 5. 四种验证结果各显示对应的话；verify_status 空的不显示；不再出现 not_run / passed / failed。
 *    「验证没跑」的原因仍在下面那块输出里。
 * 6. 失败且有说明：显示「它的说明：……」。没有说明的不显示。哪个执行器都显示。
 * 7. 排队：生效的是「我的模型」时按钮写「派发（我的模型）」；Codex、替身照旧。
 * 8. 有验收条件就逐条列出；没有的不显示。
 * 9. acceptanceTests：锁定写明几个、已锁定；没锁定写明原因；没有这一项不显示。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodingTask } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  rows: [] as CodingTask[],
  executor: 'fake' as 'fake' | 'codex-cli' | 'model',
  realDispatch: false,
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
    status: 'pending_accept',
    version: 1,
    ...patch,
  } as unknown as CodingTask;
}

const execReport = (patch: Record<string, unknown>) =>
  JSON.stringify({
    claimedSuccess: true,
    summary: '',
    changedPaths: [],
    testsModified: false,
    raw: '',
    ...patch,
  });

beforeEach(() => {
  harness.executor = 'fake';
  harness.realDispatch = false;
  harness.rows = [];
  harness.listCodingTasks.mockImplementation(async () => ({
    executor: harness.executor,
    realDispatchEnabled: harness.realDispatch,
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
    root.unmount();
  });
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(TasksPage, { projects: [] }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const card = (id: string) => container.querySelector(`[data-testid="task-${id}"]`);
const text = (id: string) => card(id)?.textContent ?? '';
const statusLine = (id: string) =>
  Array.from(card(id)?.querySelectorAll('p') ?? []).find((p) =>
    (p.textContent ?? '').includes('版本'),
  )?.textContent ?? '';

describe('U5 任务卡片说人话', () => {
  it('条件 5：四种验证结果说人话；空的不显示；状态行不再有英文状态词；原因在输出里', async () => {
    harness.rows = [
      task('pass', { verify_status: 'passed', verify_output: 'ok' }),
      task('fail', { verify_status: 'failed', verify_output: '断言没过' }),
      task('skip', { verify_status: 'not_run', verify_output: '工作区里没有 pnpm' }),
      task('none', { verify_status: 'not_run', verify_output: '没有有效验证命令' }),
      task('blank', { verify_status: null, verify_output: null }),
    ];
    await render();
    expect(statusLine('pass')).toContain('验证通过');
    expect(statusLine('fail')).toContain('验证没通过');
    expect(statusLine('skip')).toContain('验证没跑');
    expect(statusLine('none')).toContain('还没有独立验收');
    expect(statusLine('blank')).not.toContain('验证');
    for (const id of ['pass', 'fail', 'skip', 'none', 'blank']) {
      expect(statusLine(id)).not.toMatch(/not_run|passed|failed/);
    }
    expect(text('skip')).toContain('工作区里没有 pnpm');
  });

  it('条件 6：失败且有说明才显示「它的说明」；哪个执行器都显示', async () => {
    const failed = (summary: string, claimed = false) =>
      execReport({ claimedSuccess: claimed, summary });
    harness.rows = [
      task('said', {
        status: 'failed',
        executor_name: 'model:m',
        executor_report_json: failed('写不了这个文件'),
      }),
      task('codex', {
        status: 'failed',
        executor_name: 'codex-cli',
        executor_report_json: failed('越界了'),
      }),
      task('nosum', {
        status: 'failed',
        executor_name: 'model:m',
        executor_report_json: failed('  '),
      }),
      task('ok', { status: 'pending_accept', executor_report_json: failed('不该出现') }),
    ];
    await render();
    expect(container.querySelector('[data-testid="task-explanation-said"]')?.textContent).toBe(
      '它的说明：写不了这个文件',
    );
    expect(container.querySelector('[data-testid="task-explanation-codex"]')?.textContent).toBe(
      '它的说明：越界了',
    );
    expect(container.querySelector('[data-testid="task-explanation-nosum"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-explanation-ok"]')).toBeNull();
  });

  it('条件 7：排队时，我的模型写「派发（我的模型）」；Codex、替身照旧', async () => {
    harness.rows = [task('q', { status: 'queued' })];
    harness.executor = 'model';
    await render();
    expect(text('q')).toContain('派发（我的模型）');
    expect(text('q')).not.toContain('派发（Codex）');
    expect(text('q')).not.toContain('派发（Fake）');

    harness.executor = 'codex-cli';
    harness.realDispatch = true;
    await render();
    expect(text('q')).toContain('派发（Codex）');

    harness.executor = 'fake';
    harness.realDispatch = false;
    await render();
    expect(text('q')).toContain('派发（Fake）');
  });

  it('条件 8：有验收条件就逐条列；没有的不显示这一块', async () => {
    harness.rows = [
      task('has', { acceptance_json: JSON.stringify(['文件里有你好', '测试过了']) }),
      task('empty', { acceptance_json: '[]' }),
      task('miss', { acceptance_json: null }),
    ];
    await render();
    const box = container.querySelector('[data-testid="task-acceptance-has"]')!;
    expect(box.textContent).toContain('验收条件：');
    expect(box.textContent).toContain('文件里有你好');
    expect(box.textContent).toContain('测试过了');
    expect(container.querySelector('[data-testid="task-acceptance-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-acceptance-miss"]')).toBeNull();
  });

  it('条件 9：验收测试锁定写个数；没锁定写原因；没有这一项不显示', async () => {
    harness.rows = [
      task('locked', {
        executor_report_json: execReport({
          acceptanceTests: { files: ['a.test.ts', 'b.test.ts'], locked: true, reason: null },
        }),
      }),
      task('open', {
        executor_report_json: execReport({
          acceptanceTests: { files: ['a.test.ts'], locked: false, reason: '测不出这次改动' },
        }),
      }),
      task('noreason', {
        executor_report_json: execReport({
          acceptanceTests: { files: [], locked: false, reason: '  ' },
        }),
      }),
      task('absent', { executor_report_json: execReport({}) }),
    ];
    await render();
    expect(
      container.querySelector('[data-testid="task-acceptance-tests-locked"]')?.textContent,
    ).toBe('验收测试 2 个，已锁定');
    expect(container.querySelector('[data-testid="task-acceptance-tests-open"]')?.textContent).toBe(
      '验收测试没锁定：测不出这次改动',
    );
    expect(
      container.querySelector('[data-testid="task-acceptance-tests-noreason"]')?.textContent,
    ).toBe('验收测试没锁定');
    expect(container.querySelector('[data-testid="task-acceptance-tests-absent"]')).toBeNull();
  });
});
