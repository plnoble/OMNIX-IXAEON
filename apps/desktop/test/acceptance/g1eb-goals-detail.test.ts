// @vitest-environment jsdom
/**
 * G1e-b 验收（规格 docs/委派/G1-GoalEngine-草案.md 第 5 节，用户 2026-10-30 定只读）：
 * 33. 详情页显示描述、子目标、当前方案步骤（每步状态，不能改）、方案历史（旧版本能看）、
 *     关联任务、事件时间线（每条写明 decided_by）。
 * 34. 详情页也没有任何能改目标 / 方案 / 步骤 / 关联的控件。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalDetailView } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = '2026-10-01T00:00:00.000Z';

function detail(id: string, patch: Partial<GoalDetailView> = {}): GoalDetailView {
  return {
    id,
    title: '合成目标：把周报自动化',
    description: '每周五自动生成周报',
    status: 'active',
    origin: 'user',
    confirmation: 'ui',
    priority: 0,
    progress: 42,
    progressMode: 'manual',
    nextReviewAt: null,
    targetDate: null,
    blockedReason: null,
    watch: false,
    watchReason: null,
    parentGoalId: null,
    createdAt: T,
    updatedAt: T,
    children: [{ id: 'child', title: '合成子目标', status: 'completed', progress: 100 }],
    nextStep: { id: 's2', seq: 2, title: '写初稿' },
    plans: [
      {
        version: 1,
        status: 'superseded',
        reason: '第一版太粗',
        createdAt: T,
        steps: [
          {
            id: 's0',
            seq: 1,
            title: '旧步骤',
            status: 'pending',
            deps: [],
            linkedKind: null,
            linkedTitle: null,
            linkedStatus: null,
          },
        ],
      },
      {
        version: 2,
        status: 'current',
        reason: '拆细一点',
        createdAt: T,
        steps: [
          {
            id: 's1',
            seq: 1,
            title: '收集资料',
            status: 'done',
            deps: [],
            linkedKind: null,
            linkedTitle: null,
            linkedStatus: null,
          },
          {
            id: 's2',
            seq: 2,
            title: '写初稿',
            status: 'pending',
            deps: ['s1'],
            linkedKind: 'todo',
            linkedTitle: '合成待办：找模板',
            linkedStatus: 'accepted',
          },
        ],
      },
    ],
    links: [{ kind: 'todo', refId: 'td-1', title: '合成待办：找模板', status: 'accepted' }],
    events: [
      { id: 'e1', at: T, kind: 'created', decidedBy: 'user', summary: '用户建了这个目标' },
      { id: 'e2', at: T, kind: 'step', decidedBy: 'agent', summary: '步骤开始：收集资料' },
    ],
    ...patch,
  };
}

const harness = vi.hoisted(() => ({
  summaries: [] as unknown[],
  full: null as unknown,
  listGoals: vi.fn(),
  getGoalDetail: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: { listGoals: harness.listGoals, getGoalDetail: harness.getGoalDetail },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { GoalsPage } from '../../src/renderer/src/pages/Goals.js';

let container: HTMLDivElement;
let root: Root;

const $ = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const text = (testId: string) => $(testId)?.textContent ?? '';

beforeEach(() => {
  for (const fn of [harness.listGoals, harness.getGoalDetail]) fn.mockClear();
  const full = detail('active');
  harness.summaries = [full];
  harness.full = full;
  harness.listGoals.mockImplementation(async () => harness.summaries);
  harness.getGoalDetail.mockImplementation(async () => harness.full);
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

async function click(testId: string): Promise<void> {
  await act(async () => {
    $(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Goals 详情（只读）', () => {
  it('33. 显示描述、子目标、步骤状态、方案历史、关联任务、事件及 decided_by', async () => {
    await render();
    await click('goal-active');

    expect(harness.getGoalDetail).toHaveBeenCalledWith('active');
    expect($('goal-detail')).not.toBeNull();
    expect(text('goal-detail-description')).toContain('每周五自动生成周报');
    expect(text('goal-detail-children')).toContain('合成子目标');
    expect(text('goal-step-s1')).toContain('收集资料');
    expect(text('goal-step-s1')).toContain('做完');
    expect(text('goal-step-s2')).toContain('写初稿');
    expect(text('goal-step-s2')).toContain('待做');
    expect(text('goal-step-s2')).toContain('合成待办：找模板');
    expect(text('goal-detail-history')).toContain('v1');
    expect(text('goal-detail-history')).toContain('已被取代');
    expect(text('goal-detail-history')).toContain('第一版太粗');
    expect(text('goal-detail-history')).toContain('旧步骤');
    expect(text('goal-detail-links')).toContain('合成待办：找模板');
    expect(text('goal-detail-events')).toContain('用户');
    expect(text('goal-detail-events')).toContain('模型');
  });

  it('33. 子目标能点进去看它自己的详情（树，不画图）', async () => {
    const child = detail('child', {
      title: '合成子目标',
      description: '子目标自己的描述',
      children: [],
      plans: [],
      links: [],
      events: [],
    });
    harness.getGoalDetail.mockImplementation(async (id: string) =>
      id === 'child' ? child : harness.full,
    );
    await render();
    await click('goal-active');
    await click('goal-child-child');

    expect(harness.getGoalDetail).toHaveBeenLastCalledWith('child');
    expect(text('goal-detail-description')).toContain('子目标自己的描述');
    expect(text('goal-detail-steps')).toContain('还没有方案');

    await click('goal-back');
    expect($('goals-list')).not.toBeNull();
  });

  it('34. 详情页没有能改目标 / 方案 / 步骤 / 关联的控件，只能返回或进子目标', async () => {
    await render();
    await click('goal-active');

    expect(container.querySelector('input, textarea, select, form')).toBeNull();
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    for (const forbidden of ['确认', '不是这个', '改', '推进', '重规划', '挂', '改状态']) {
      expect(labels.some((l) => l.includes(forbidden))).toBe(false);
    }
    expect(labels).toEqual(['返回列表', '合成子目标 · 已完成 · 100%']);

    await click('goal-back');
    expect($('goal-detail')).toBeNull();
    expect($('goals-list')).not.toBeNull();
  });
});