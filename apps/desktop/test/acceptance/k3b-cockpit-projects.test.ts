// @vitest-environment jsdom
/**
 * K3b 验收（规格 docs/委派/K3-驾驶舱页面.md 条件 3；K3 的源码超过 300 行，按规格把
 * 「项目」区拆到这一支）。
 *
 * 条件 3：项目各组 3 / 10 / 1 → 「进行中」显示 3 张卡片；「暂缓（10）」「放弃（1）」
 *         默认折叠，点开后分别显示 10 张和 1 张；卡片上的状态切换复用
 *         `api.updateProjectStatus`。
 * 条件 5 的项目区：空快照 → 项目区显示空状态文字，没有报错（其余各区在 K3 的测试里）。
 */
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitSnapshot, ProjectCard, SourceHealth } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date('2026-10-31T12:00:00+08:00');

const harness = vi.hoisted(() => ({
  snapshot: null as unknown,
  updates: [] as Array<{ id: string; status: string }>,
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api: {
    getCockpitSnapshot: async () => harness.snapshot,
    updateProjectStatus: async (input: { id: string; status: string }) => {
      harness.updates.push({ id: input.id, status: input.status });
      // 真 IPC 会写库，下一次快照就按新状态分组；替身照着改，别让「切完不刷新」也能过。
      const s = harness.snapshot as CockpitSnapshot;
      const all = [...s.projects.active, ...s.projects.paused, ...s.projects.archived].map((p) =>
        p.id === input.id ? { ...p, status: input.status } : p,
      );
      harness.snapshot = {
        ...s,
        projects: {
          active: all.filter((p) => p.status === 'active'),
          paused: all.filter((p) => p.status === 'paused'),
          archived: all.filter((p) => p.status === 'archived'),
        },
      };
      return { id: input.id, status: input.status };
    },
  },
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { CockpitPage } from '../../src/renderer/src/pages/Cockpit.js';

let container: HTMLDivElement;
let root: Root;

const health = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  status: 'ok',
  readAt: NOW.toISOString(),
  lastEventAt: null,
  note: null,
  ...over,
});

const card = (id: string, status: string): ProjectCard => ({
  id,
  name: `合成项目 ${id}`,
  status,
  description: `描述 ${id}`,
  currentState: `状态 ${id}`,
  updatedAt: NOW.toISOString(),
});

const snapshot = (over: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({
  generatedAt: NOW.toISOString(),
  sources: { relay: health(), queue: health(), projects: health() },
  attention: [],
  running: [],
  projects: { active: [], paused: [], archived: [] },
  recent: [],
  today: { finishedTurns: 0 },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness.snapshot = snapshot();
  harness.updates = [];
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
    root.render(createElement(CockpitPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const $ = <T extends Element>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

const count = (testId: string): number =>
  container.querySelectorAll(`[data-testid="${testId}"]`).length;

const cards = (): number =>
  container.querySelectorAll('[data-testid^="cockpit-project-card-"]').length;

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

describe('条件 3：项目分组与状态切换', () => {
  const active = ['a0', 'a1', 'a2'].map((id) => card(id, 'active'));
  const paused = Array.from({ length: 10 }, (_, i) => card(`p${i}`, 'paused'));
  const archived = [card('z0', 'archived')];

  it('进行中显示 3 张；暂缓（10）/ 放弃（1）默认折叠，点开后 10 张 / 1 张', async () => {
    harness.snapshot = snapshot({ projects: { active, paused, archived } });
    await render();
    expect(cards()).toBe(3);
    expect($('cockpit-group-paused')!.textContent).toContain('暂缓（10）');
    expect($('cockpit-group-archived')!.textContent).toContain('放弃（1）');
    expect(count('cockpit-project-card-p0')).toBe(0);
    expect(count('cockpit-project-card-z0')).toBe(0);
    await click($('cockpit-group-paused'));
    expect(count('cockpit-project-card-p0')).toBe(1);
    expect(container.querySelectorAll('[data-status="paused"]').length).toBe(10);
    await click($('cockpit-group-archived'));
    expect(count('cockpit-project-card-z0')).toBe(1);
    expect(container.querySelectorAll('[data-status="archived"]').length).toBe(1);
  });

  it('卡片上的状态切换复用 api.updateProjectStatus，卡片跟着换组、计数跟着变，也能恢复', async () => {
    harness.snapshot = snapshot({ projects: { active, paused, archived } });
    await render();
    await click($('cockpit-project-pause-a0'));
    expect(harness.updates).toEqual([{ id: 'a0', status: 'paused' }]);
    expect(cards()).toBe(2);
    expect($('cockpit-group-paused')!.textContent).toContain('暂缓（11）');
    expect($('cockpit-project-card-a0')).toBeNull();
    await click($('cockpit-group-paused'));
    expect($('cockpit-project-card-a0')!.getAttribute('data-status')).toBe('paused');

    await click($('cockpit-project-resume-a0'));
    expect(harness.updates).toEqual([
      { id: 'a0', status: 'paused' },
      { id: 'a0', status: 'active' },
    ]);
    expect(container.querySelectorAll('[data-status="active"]').length).toBe(3);
    expect($('cockpit-group-paused')!.textContent).toContain('暂缓（10）');
    expect($('cockpit-project-card-a0')!.getAttribute('data-status')).toBe('active');

    await click($('cockpit-project-archive-a1'));
    expect(harness.updates.at(-1)).toEqual({ id: 'a1', status: 'archived' });
    expect(container.querySelectorAll('[data-status="active"]').length).toBe(2);
    expect($('cockpit-group-archived')!.textContent).toContain('放弃（2）');
  });

  it('调度器那一条同时写「已跑 N 分钟」和进程/开始时间', async () => {
    harness.snapshot = snapshot({
      running: [
        {
          kind: 'relay',
          role: null,
          taskId: null,
          startedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          until: null,
          text: '调度器在转（进程 123），从 11:55 起',
        },
      ],
    });
    await render();
    const row = $('cockpit-running-item')!.textContent ?? '';
    expect(row).toContain('已跑 5 分钟');
    expect(row).toContain('进程 123');
  });
});

describe('条件 5 的项目区：空快照', () => {
  it('项目区显示空状态文字，没有报错', async () => {
    await render();
    expect($('cockpit-projects-empty')!.textContent).toContain('现在没有项目');
    expect($('error-banner')).toBeNull();
  });
});
