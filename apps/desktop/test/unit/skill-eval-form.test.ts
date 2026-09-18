// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const evaluateSkillWithEvidence = vi.fn();
const listCodingTasks = vi.fn();
const listSkillCandidates = vi.fn();

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    listCodingTasks: (...args: unknown[]) => listCodingTasks(...args),
    listSkillCandidates: (...args: unknown[]) => listSkillCandidates(...args),
    evaluateSkillWithEvidence: (...args: unknown[]) => evaluateSkillWithEvidence(...args),
  },
  errMsg: (err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err);
    const m = /^(IXA\d{4})\s+(.*)$/.exec(raw);
    return m ? `${m[1]}：${m[2]}` : raw;
  },
}));

import { TasksPage } from '../../src/renderer/src/pages/Tasks.js';

const skill = {
  id: 'skill-1',
  project_id: null,
  title: '测试技能',
  problem: '失败',
  method: '重试',
  eval_case: '',
  status: 'proposed' as const,
  eval_before: null,
  eval_after: null,
  benefit: null,
  version: 1,
  eval_evidence_json: null,
  approved_version: null,
  created_from_work_run_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const task = {
  id: 'task-1',
  project_id: 'proj-1',
  goal: '修 note.txt',
  scope_json: '[]',
  workspace_path: null,
  snapshot_ref: null,
  context_digest: '',
  allowed_commands_json: '[]',
  timeout_ms: 1000,
  status: 'completed' as const,
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
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  evaluateSkillWithEvidence.mockReset();
  listCodingTasks.mockResolvedValue({
    executor: 'fake',
    realDispatchEnabled: false,
    notice: '测试',
    tasks: [task],
  });
  listSkillCandidates.mockResolvedValue([skill]);
  (window as unknown as { ixaeon: Record<string, unknown> }).ixaeon = {
    listCodingTasks,
    listSkillCandidates,
    evaluateSkillWithEvidence,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(createElement(TasksPage, { projects: [] }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('技能受控对照验证表单', () => {
  it('填齐后点运行，把拆好的命令交给接口', async () => {
    evaluateSkillWithEvidence.mockResolvedValue({ ok: true });
    await renderPage();
    await act(async () => {
      container
        .querySelector('[data-testid="skill-eval-open"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const command = container.querySelector(
      '[data-testid="skill-eval-command"]',
    ) as HTMLInputElement;
    const benefit = container.querySelector(
      '[data-testid="skill-eval-benefit"]',
    ) as HTMLTextAreaElement;
    const taskSelect = container.querySelector(
      '[data-testid="skill-eval-task"]',
    ) as HTMLSelectElement;
    const setInput = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    const setArea = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      taskSelect.value = 'task-1';
      taskSelect.dispatchEvent(new Event('change', { bubbles: true }));
      setInput.call(command, 'node "my script.js" --x');
      command.dispatchEvent(new Event('input', { bubbles: true }));
      setArea.call(benefit, '能过验证');
      benefit.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('[data-testid="skill-eval-run"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(evaluateSkillWithEvidence).toHaveBeenCalledWith({
      id: 'skill-1',
      method: '重试',
      command: ['node', 'my script.js', '--x'],
      taskId: 'task-1',
      benefit: '能过验证',
    });
  });

  it('后端抛错：原文出现在表单下方，填写内容还在', async () => {
    evaluateSkillWithEvidence.mockRejectedValue(new Error('IXA0001 没有失败基线'));
    await renderPage();
    await act(async () => {
      container
        .querySelector('[data-testid="skill-eval-open"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const command = container.querySelector(
      '[data-testid="skill-eval-command"]',
    ) as HTMLInputElement;
    const benefit = container.querySelector(
      '[data-testid="skill-eval-benefit"]',
    ) as HTMLTextAreaElement;
    const setInput = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    const setArea = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setInput.call(command, 'npm test');
      command.dispatchEvent(new Event('input', { bubbles: true }));
      setArea.call(benefit, '更快');
      benefit.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('[data-testid="skill-eval-run"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="skill-eval-error"]')?.textContent).toContain(
      '没有失败基线',
    );
    expect(command.value).toBe('npm test');
    expect(benefit.value).toBe('更快');
  });
});
