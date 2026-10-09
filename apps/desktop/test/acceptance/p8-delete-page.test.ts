// @vitest-environment jsdom
/**
 * P8 验收条件 10（规格 docs/委派/P8-删除项目时撤销授权并清副本.md，契约 4）：
 * 项目页「删除」的确认框与结果。B 档：先只交测试，整合方锁定后再写实现。
 *
 * - 绑着文件夹：点了先调 previewUnbindProjectFolder 再 window.confirm；没绑的不调预览直接问。
 * - 确认框文字逐字：第一段（原来的话加了一句副本）+ 绑着时才有的「这个项目绑着文件夹：」段
 *   （三种讲授权的说法都以「- 」开头，带数字的行数字是 0 就不出现）。
 * - 取消确认不调 deleteProject；确认调了、列表重新读、结果（project-delete-result）四种成分
 *   各自有没有、如实接。
 * - 出错显示在报错条；预览出错时不问、不删。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../../src/renderer/src/api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listWorkRuns: vi.fn(async () => []),
  previewUnbindProjectFolder: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof ApiModule;
  return { ...actual, api: { ...actual.api, ...harness } };
});

import { ProjectsPage } from '../../src/renderer/src/pages/Projects.js';

const ROOT = 'D:/synth/repo';
const project = (id: string, name: string, rootPath: string | null) =>
  ({
    id,
    name,
    root_path: rootPath,
    description: null,
    status: 'active',
    created_at: '2026-10-01T08:00:00.000Z',
    updated_at: '2026-10-01T08:00:00.000Z',
    purpose: null,
    current_state: null,
    primary_io: null,
    capabilities: null,
    related_goals: null,
    unknowns: null,
  }) as never;

const HEAD_UNBOUND = [
  '删除项目「合成项目」？',
  '',
  '属于该项目的理解、关系、编码任务会删除，编码任务的隔离副本（里面有当时的项目文件）也一并删掉。来源会变成未归属，对话原文保留。个人记忆不动。此操作不能从列表撤销（可用备份恢复）。',
];
const GRANT_REVOKE = '- 这个文件夹的读取授权一并撤销。';
const GRANT_KEPT = '- 读取授权不撤销：另一个项目也绑着这个文件夹。';
const GRANT_NONE = '- 这个文件夹没有单独的读取授权，没有可撤销的。';

function previewOf(patch = {}) {
  return {
    rootPath: ROOT,
    inFlightTasks: 0,
    pendingAcceptTasks: 0,
    sourcesUnderGrant: 0,
    grant: 'revoke',
    ...patch,
  } as never;
}

let container: HTMLDivElement;
let root: Root;
let rows: unknown[];
const confirm = vi.fn<(message?: string) => boolean>();
const calls: string[] = [];

const removeResult = (patch = {}) => ({
  sourcesUnassigned: 0,
  itemsRemoved: 0,
  revokedPermissionId: null,
  cancelledTasks: 0,
  copiesRemoved: 0,
  copiesLeft: 0,
  ...patch,
});

beforeEach(() => {
  calls.length = 0;
  rows = [project('p1', '合成项目', ROOT), project('p2', '构想项目', null)];
  harness.listProjects.mockReset().mockImplementation(async () => {
    calls.push('listProjects');
    return rows.map((p) => ({ ...p }));
  });
  harness.listWorkRuns.mockClear();
  harness.previewUnbindProjectFolder.mockReset().mockImplementation(async (id: string) => {
    calls.push(`preview:${id}`);
    return previewOf();
  });
  harness.deleteProject.mockReset().mockImplementation(async (id: string) => {
    calls.push(`delete:${id}`);
    rows = rows.filter((p) => p.id !== id);
    return removeResult();
  });
  confirm.mockReset().mockImplementation(() => {
    calls.push('confirm');
    return true;
  });
  vi.stubGlobal('confirm', confirm);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ProjectsPage, { onOpenSources: () => undefined, onChanged: () => undefined }),
    );
  });
  await settle();
}

const $ = (testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`);

async function clickDelete(id = 'p1'): Promise<void> {
  await act(async () => {
    ($(`project-delete-${id}`) as HTMLButtonElement).click();
  });
  await settle();
}

describe('条件 10：删除项目的确认框', () => {
  it('没绑文件夹：不调预览；确认框只有前两段', async () => {
    await render();
    await clickDelete('p2');
    expect(harness.previewUnbindProjectFolder).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0]![0]).toBe(HEAD_UNBOUND.join('\n'));
  });

  it('绑着、授权会撤销、数字都不是 0：整段逐字', async () => {
    harness.previewUnbindProjectFolder.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return previewOf({ sourcesUnderGrant: 3, inFlightTasks: 2 });
    });
    await render();
    await clickDelete();
    expect(calls).toEqual(['listProjects', 'preview:p1', 'confirm']);
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        ...HEAD_UNBOUND,
        '这个项目绑着文件夹：',
        ROOT,
        GRANT_REVOKE,
        '- 这条授权下导入过 3 份资料：之后不再读它们的原文。',
        '- 有 2 个编码任务正在排队或执行，会被取消。',
      ].join('\n'),
    );
  });

  it('别处也绑着/没有单独授权：讲授权的行跟着 grant 变；数字 0 的行不出现', async () => {
    harness.previewUnbindProjectFolder.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return previewOf({ grant: 'kept_other_project', sourcesUnderGrant: 5 });
    });
    await render();
    await clickDelete();
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        ...HEAD_UNBOUND,
        '这个项目绑着文件夹：',
        ROOT,
        GRANT_KEPT,
        '- 这条授权下导入过 5 份资料：之后不再读它们的原文。',
      ].join('\n'),
    );
    confirm.mockClear();
    harness.previewUnbindProjectFolder.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return previewOf({ grant: 'none' });
    });
    await clickDelete('p1');
    expect(confirm.mock.calls[0]![0]).toBe(
      [...HEAD_UNBOUND, '这个项目绑着文件夹：', ROOT, GRANT_NONE].join('\n'),
    );
  });

  it('取消确认：不调 deleteProject，项目行不变', async () => {
    confirm.mockReturnValue(false);
    await render();
    await clickDelete();
    expect(harness.deleteProject).not.toHaveBeenCalled();
    expect($('project-row-p1')).not.toBeNull();
    expect($('project-delete-result')).toBeNull();
  });

  it('确认：调了、列表重读、结果句四种成分按实际接', async () => {
    harness.deleteProject.mockImplementation(async (id: string) => {
      calls.push(`delete:${id}`);
      rows = rows.filter((p) => p.id !== id);
      return removeResult({
        revokedPermissionId: 'grant-1',
        cancelledTasks: 2,
        copiesLeft: 1,
      });
    });
    await render();
    await clickDelete();
    expect(harness.deleteProject).toHaveBeenCalledWith('p1');
    expect(calls.filter((c) => c === 'listProjects').length).toBe(2);
    expect($('project-row-p1')).toBeNull();
    const text = $('project-delete-result')?.textContent?.replace(/\s+/g, '') ?? null;
    expect(text).toBe(
      '已删除项目「合成项目」。这个文件夹的读取授权已撤销。取消了2个编码任务。有1个任务副本没删掉（文件正被占用），还在数据目录的workspaces里。',
    );
  });

  it('没撤销、没取消、没剩副本：结果句只有第一句', async () => {
    await render();
    await clickDelete();
    expect($('project-delete-result')?.textContent?.replace(/\s+/g, '')).toBe(
      '已删除项目「合成项目」。',
    );
  });

  it('预览出错：不问、不删，报错条显示，项目行不变', async () => {
    harness.previewUnbindProjectFolder.mockImplementation(async () => {
      throw new Error('合成的预览失败');
    });
    await render();
    await clickDelete();
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.deleteProject).not.toHaveBeenCalled();
    expect($('error-banner')?.textContent).toContain('合成的预览失败');
    expect($('project-row-p1')).not.toBeNull();
    expect($('project-delete-result')).toBeNull();
  });

  it('删除出错：报错条显示，项目行不变', async () => {
    harness.deleteProject.mockImplementation(async () => {
      throw new Error('合成的删除失败');
    });
    await render();
    await clickDelete();
    expect($('error-banner')?.textContent).toContain('合成的删除失败');
    expect($('project-row-p1')).not.toBeNull();
    expect($('project-delete-result')).toBeNull();
  });
});
