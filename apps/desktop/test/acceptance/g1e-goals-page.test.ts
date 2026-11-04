// @vitest-environment jsdom
/**
 * G1e 验收（规格 docs/委派/G1-GoalEngine-草案.md 第 5 节，用户 2026-10-30 定只读）：
 * 30. 列表显示 active 目标的标题、状态、进度、下次复核；过期复核标黄。
 * 31. blocked 卡片直接显示 blocked_reason；有 watch 的单独标出并显示 watch_reason。
 * 32. proposed 在顶部单独一块只显示，标明「待你确认」，没有确认 / 驳回按钮。
 * 34. 界面上没有任何能改目标 / 方案 / 步骤 / 关联的控件。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSummaryView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = '2026-10-01T00:00:00.000Z';
const PAST = '2026-09-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

function goal(id: string, patch: Partial<GoalSummaryView> = {}): GoalSummaryView {
  return {
    id,
    title: `合成目标 ${id}`,
    description: `合成目标 ${id} 的描述`,
    status: 'active',
    origin: 'user',
    confirmation: 'ui',
    priority: 0,
    progress: 0,
    progressMode: 'manual',
    nextReviewAt: FUTURE,
    targetDate: null,
    blockedReason: null,
    watch: false,
    watchReason: null,
    parentGoalId: null,
    createdAt: T,
    updatedAt: T,
    children: [],
    nextStep: null,
    ...patch,
  };
}

const harness = vi.hoisted(() => ({ rows: [] as unknown[], listGoals: vi.fn() }));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: { listGoals: harness.listGoals },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { GoalsPage } from '../../src/renderer/src/pages/Goals.js';

let container: HTMLDivElement;
let root: Root;

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const text = (testId: string) => $(testId)?.textContent ?? '';

beforeEach(() => {
  harness.listGoals.mockClear();
  harness.rows = [
    goal('active', {
      title: '合成目标：把周报自动化',
      description: '每周五自动生成周报',
      progress: 42,
      nextReviewAt: PAST,
      watch: true,
      watchReason: '编码任务失败：生成脚本没跑通',
      children: [{ id: 'child', title: '合成子目标', status: 'completed', progress: 100 }],
      nextStep: { id: 's2', seq: 2, title: '写初稿' },
    }),
    goal('blocked', {
      title: '合成目标：换服务器',
      status: 'blocked',
      blockedReason: '预算还没批',
      progress: 20,
    }),
    goal('child', {
      title: '合成子目标',
      status: 'completed',
      progress: 100,
      parentGoalId: 'active',
    }),
    goal('proposed', {
      title: '合成候选目标：每天读论文',
      status: 'proposed',
      origin: 'agent',
      confirmation: 'pending',
      nextReviewAt: null,
      watch: true,
      watchReason: '同一个目标提了两次',
    }),
  ];
  harness.listGoals.mockImplementation(async () => harness.rows);
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
    root.render(createElement(GoalsPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('Goals 列表（只读）', () => {
  it('30. 列表显示 active 的标题、状态、进度、下次复核；过期复核标黄', async () => {
    await render();
    expect(text('goal-active')).toContain('合成目标：把周报自动化');
    expect(text('goal-active')).toContain('进行中');
    expect($('goal-progress-active')?.querySelector('progress')?.getAttribute('value')).toBe('42');
    expect(text('goal-progress-active')).toContain('42%');
    expect(text('goal-progress-active')).toContain('子目标 1 个');
    expect(text('goal-review-active')).toContain('下次复核：2026-09-01');
    expect(text('goal-review-active')).toContain('已过期');
    expect($('goal-review-active')?.className).toContain('warn');
    expect(text('goal-next-active')).toContain('2. 写初稿');
  });

  it('31. blocked 直接显示原因；watch 单独标出并显示原因', async () => {
    await render();
    expect(text('goal-blocked-blocked')).toContain('预算还没批');
    expect($('goal-watch-active')?.textContent).toContain('有疑点');
    expect($('goal-watch-active')?.textContent).toContain('编码任务失败：生成脚本没跑通');
    expect($('goal-proposed-watch-proposed')?.textContent).toContain('同一个目标提了两次');
    expect($('goal-blocked-active')).toBeNull();
  });

  it('32. proposed 在顶部单独一块只显示，没有确认 / 驳回按钮', async () => {
    await render();
    const proposed = $('goals-proposed');
    expect(proposed?.textContent).toContain('合成候选目标：每天读论文');
    expect(proposed?.textContent).toContain('待你确认');
    expect(proposed?.querySelector('button')).toBeNull();
    expect($('goals-list')?.textContent).not.toContain('合成候选目标：每天读论文');

    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('确认');
    expect(labels).not.toContain('不是这个');
  });

  it('34. 界面上没有任何能改目标 / 方案 / 步骤 / 关联的控件', async () => {
    await render();
    expect(container.querySelector('input, textarea, select, form')).toBeNull();
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    for (const forbidden of ['确认', '不是这个', '改', '推进', '重规划', '挂', '改状态']) {
      expect(labels.some((l) => l.includes(forbidden))).toBe(false);
    }
  });
});