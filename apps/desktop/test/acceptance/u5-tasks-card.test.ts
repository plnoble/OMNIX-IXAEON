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
import { executorExplanation, verifyLabel, type CodingTask } from '@ixaeon/contracts';
import { buildTaskReport, type TaskReportRow } from '../../src/main/taskReport.js';

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
        error: '执行器未声称成功',
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
    const said = container.querySelector('[data-testid="task-said"]')!;
    const reason = Array.from(said.querySelectorAll('p.warn')).find((p) =>
      (p.textContent ?? '').includes('执行器未声称成功'),
    );
    expect(reason).toBeTruthy();
    const explanation = container.querySelector('[data-testid="task-explanation-said"]')!;
    expect(explanation.textContent).toBe('它的说明：写不了这个文件');
    expect(
      reason!.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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

describe('U5 两句共用的话（条件 1、3）', () => {
  it('verifyLabel 四种结果，not_run 的两种情况分得开', () => {
    expect(verifyLabel({ verify_status: 'passed', verify_output: 'ok' })).toBe('验证通过');
    expect(verifyLabel({ verify_status: 'failed', verify_output: '断言没过' })).toBe('验证没通过');
    expect(verifyLabel({ verify_status: 'not_run', verify_output: '  工作区里没有 pnpm  ' })).toBe(
      '验证没跑',
    );
    expect(verifyLabel({ verify_status: 'not_run', verify_output: '没有有效验证命令' })).toBe(
      '还没有独立验收',
    );
    expect(verifyLabel({ verify_status: 'not_run', verify_output: '  ' })).toBe('还没有独立验收');
    expect(verifyLabel({ verify_status: 'not_run', verify_output: null })).toBe('还没有独立验收');
    expect(verifyLabel({ verify_status: null, verify_output: null })).toBe('还没有独立验收');
  });

  it('executorExplanation：带说明才返回；坏的报告是 null，不抛', () => {
    const report = (summary: unknown, claimed: unknown = false) =>
      JSON.stringify({
        claimedSuccess: claimed,
        summary,
        changedPaths: [],
        testsModified: false,
        raw: '',
      });
    expect(
      executorExplanation({ status: 'failed', executor_report_json: report('  做不到  ') }),
    ).toBe('做不到');
    expect(
      executorExplanation({ status: 'pending_accept', executor_report_json: report('做不到') }),
    ).toBe(null);
    expect(
      executorExplanation({ status: 'failed', executor_report_json: report('做不到', true) }),
    ).toBe(null);
    expect(executorExplanation({ status: 'failed', executor_report_json: report('   ') })).toBe(
      null,
    );
    expect(executorExplanation({ status: 'failed', executor_report_json: null })).toBe(null);
    expect(executorExplanation({ status: 'failed', executor_report_json: '不是 json' })).toBe(null);
    expect(executorExplanation({ status: 'failed', executor_report_json: 'null' })).toBe(null);
    expect(executorExplanation({ status: 'failed', executor_report_json: report(12) })).toBe(null);
  });
});

describe('U5 回报的文字一个字不变', () => {
  const row = (patch: Partial<TaskReportRow>): TaskReportRow =>
    ({
      id: 't',
      goal: '合成目标',
      status: 'pending_accept',
      error: null,
      origin_run_id: null,
      acceptance_json: null,
      verify_status: null,
      verify_output: null,
      executor_report_json: null,
      executor_name: null,
      applied_ref: null,
      applied_at: null,
      apply_error: null,
      ...patch,
    }) as TaskReportRow;

  it('条件 2：验证那一句和改之前逐字一样', () => {
    const line = (verify_status: string, verify_output: string) =>
      buildTaskReport(row({ verify_status, verify_output }))!
        .content.split('\n')
        .find((l) => l.startsWith('验证') || l.startsWith('还没有'));
    expect(line('passed', 'ok')).toBe('验证通过');
    expect(line('not_run', '工作区里没有 pnpm')).toBe('验证没跑：工作区里没有 pnpm');
    expect(line('not_run', '没有有效验证命令')).toBe('还没有独立验收');
  });

  it('条件 4：「它的说明」只出现在「我的模型」做的失败任务里', () => {
    const report = JSON.stringify({
      claimedSuccess: false,
      summary: '写不了这个文件',
      changedPaths: [],
      testsModified: false,
      raw: '',
    });
    const model = buildTaskReport(
      row({
        status: 'failed',
        executor_name: 'model:m',
        executor_report_json: report,
        error: '没做成',
      }),
    )!.content;
    expect(model).toContain('它的说明：写不了这个文件');
    const codex = buildTaskReport(
      row({
        status: 'failed',
        executor_name: 'codex-cli',
        executor_report_json: report,
        error: '没做成',
      }),
    )!.content;
    expect(codex).not.toContain('它的说明');
    expect(codex).toBe('「合成目标」没做成。\n原因：没做成');
    const fake = buildTaskReport(
      row({
        status: 'failed',
        executor_name: 'fake',
        executor_report_json: report,
        error: '没做成',
      }),
    )!.content;
    expect(fake).toBe(codex);
  });
});
