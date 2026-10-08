// @vitest-environment jsdom
/**
 * P5 验收条件 11（规格 docs/委派/P5-解除项目的文件夹绑定.md，契约 7）：项目页的「解除绑定」。
 * 执行方先推了一版，整合方 2026-10-08 锁定前重写（规格末尾「整合方审测试时的改正与补充」）：
 * 原版只查确认框里有没有几个词，这里照规格逐字核对整段文字；补上取消、出错、预览出错几条。
 *
 * - 绑了文件夹的项目行有「解除绑定」（`project-unbind-folder-<id>`），没绑的没有；
 * - 点了先调预览，再用 `window.confirm` 问一次，文字照契约 7：带数字的三行，数字是 0 就不出现；
 *   讲授权的那一行按 `grant` 三选一（三种说法都以「- 」开头，和别的行一样）；
 * - 取消确认：不调 `unbindProjectFolder`，项目行不变，没有结果那句话；
 * - 确认：调 `unbindProjectFolder`，项目行变成「构想（未绑定目录）」和「绑定文件夹」，
 *   结果（`project-unbind-result`）如实：撤没撤销、取消了几个；结果显示在被解除的那个项目
 *   自己的行里（整合方 2026-10-08 复审实现时定的：原来放在列表最底下，项目多了看不见）；
 * - 出错（预览出错、解除出错）：显示在这一页现有的报错条里，项目行不变。
 *
 * 这一页在这些操作里只用到 listProjects、listWorkRuns、previewUnbindProjectFolder、
 * unbindProjectFolder 四个接口（pickFiles、bindProjectFolder 只在「解除之后重新绑定」那一条里放开）。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Project,
  UnbindProjectFolderPreview,
  UnbindProjectFolderResult,
} from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listWorkRuns: vi.fn(async () => []),
  previewUnbindProjectFolder: vi.fn(),
  unbindProjectFolder: vi.fn(),
  // 只有「解除之后重新绑定」那一条用得到；别的用例里调了就报错
  pickFiles: vi.fn(),
  bindProjectFolder: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api,
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { ProjectsPage } from '../../src/renderer/src/pages/Projects.js';

const ROOT = 'D:/synth/repo';
const project = (id: string, name: string, rootPath: string | null): Project =>
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
  }) as Project;

/** 契约 7 里固定不变的几行。 */
const HEAD = [
  '解除「合成项目」和这个文件夹的绑定？',
  '',
  ROOT,
  '',
  '解除之后：',
  '- IXAEON 不再读这个文件夹：不能再给这个项目派编码任务，对话里也不再带这个文件夹的项目近况。',
];
const TAIL = [
  '',
  '已经做完的任务、它们的隔离副本（里面有当时的项目文件）和已有的记忆都不动。要清掉副本，在任务页逐个删除任务。',
];
const GRANT_REVOKE = '- 这个文件夹的读取授权一并撤销。';
const GRANT_KEPT = '- 读取授权不撤销：另一个项目也绑着这个文件夹。';
const GRANT_NONE = '- 这个文件夹没有单独的读取授权，没有可撤销的。';

let container: HTMLDivElement;
let root: Root;
/** 库里现在的项目（listProjects 每次照它返回）。 */
let rows: Project[];
const confirm = vi.fn<(message?: string) => boolean>();
const calls: string[] = [];

const preview = (patch: Partial<UnbindProjectFolderPreview> = {}): UnbindProjectFolderPreview => ({
  rootPath: ROOT,
  inFlightTasks: 0,
  pendingAcceptTasks: 0,
  sourcesUnderGrant: 0,
  grant: 'revoke',
  ...patch,
});

/** unbindProjectFolder 成功：库里的项目也跟着没了路径。 */
function unbindSucceeds(patch: Partial<UnbindProjectFolderResult> = {}): void {
  api.unbindProjectFolder.mockImplementation(async (id: string) => {
    calls.push(`unbind:${id}`);
    rows = rows.map((p) => (p.id === id ? { ...p, root_path: null } : p));
    return {
      project: rows.find((p) => p.id === id)!,
      revokedPermissionId: 'grant-1',
      cancelledTaskIds: [],
      ...patch,
    } satisfies UnbindProjectFolderResult;
  });
}

beforeEach(() => {
  rows = [project('p1', '合成项目', ROOT), project('p2', '只是构想', null)];
  calls.length = 0;
  api.listProjects.mockReset().mockImplementation(async () => rows.map((p) => ({ ...p })));
  api.listWorkRuns.mockClear();
  api.previewUnbindProjectFolder.mockReset().mockImplementation(async (id: string) => {
    calls.push(`preview:${id}`);
    return preview();
  });
  api.unbindProjectFolder.mockReset();
  unbindSucceeds();
  for (const name of ['pickFiles', 'bindProjectFolder'] as const) {
    api[name].mockReset().mockImplementation(async () => {
      throw new Error(`解除绑定用不到 ${name}`);
    });
  }
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

/** 等页面把手头的异步都走完。 */
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

const q = (testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`);
const rowText = (id: string): string => q(`project-row-${id}`)?.textContent ?? '';
/** 结果那句话（不计较句子之间的空白）。 */
const resultText = (): string | null =>
  q('project-unbind-result')?.textContent?.replace(/\s+/g, '') ?? null;

async function clickUnbind(id = 'p1'): Promise<void> {
  const button = q(`project-unbind-folder-${id}`);
  expect(button, `项目 ${id} 的「解除绑定」按钮`).not.toBeNull();
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
  await settle();
}

/** 这一行还是绑着的样子。 */
function expectStillBound(): void {
  expect(rowText('p1')).toContain(ROOT);
  expect(q('project-unbind-folder-p1')).not.toBeNull();
  expect(q('project-bind-folder-p1')).toBeNull();
}

describe('条件 11：有绑定才有按钮', () => {
  it('绑了文件夹的项目行有「解除绑定」，没绑的没有', async () => {
    await render();
    expect(q('project-unbind-folder-p1')?.textContent).toBe('解除绑定');
    expect(rowText('p1')).toContain(ROOT);
    expect(q('project-unbind-folder-p2')).toBeNull();
    expect(rowText('p2')).toContain('构想（未绑定目录）');
    expect(q('project-bind-folder-p2')).not.toBeNull();
    // 没点之前不问、不调
    expect(api.previewUnbindProjectFolder).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(q('project-unbind-result')).toBeNull();
  });
});

describe('条件 11：确认框的文字照契约 7', () => {
  it('三个数字都不是 0、授权会撤销：整段一字不差', async () => {
    api.previewUnbindProjectFolder.mockResolvedValue(
      preview({ sourcesUnderGrant: 3, inFlightTasks: 2, pendingAcceptTasks: 1 }),
    );
    confirm.mockReturnValue(false);
    await render();
    await clickUnbind();

    expect(api.previewUnbindProjectFolder).toHaveBeenCalledTimes(1);
    expect(api.previewUnbindProjectFolder).toHaveBeenCalledWith('p1');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        ...HEAD,
        GRANT_REVOKE,
        '- 这条授权下导入过 3 份资料：不再读它们的原文，已经提炼出的理解保留。重新绑定也恢复不了，要再用得重新导入。',
        '- 有 2 个编码任务正在排队或执行，会被取消。',
        '- 有 1 个任务做完了还没接受：解除之后再点接受，改动落不到项目里。可以先去任务页接受，或者之后重新绑定再接受。',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('数字是 0 的行不出现', async () => {
    confirm.mockReturnValue(false);
    await render();
    await clickUnbind();
    expect(confirm.mock.calls[0]![0]).toBe([...HEAD, GRANT_REVOKE, ...TAIL].join('\n'));
  });

  it('别的项目也绑着：说不撤销；只有等接受的那一行', async () => {
    api.previewUnbindProjectFolder.mockResolvedValue(
      preview({ grant: 'kept_other_project', pendingAcceptTasks: 4 }),
    );
    confirm.mockReturnValue(false);
    await render();
    await clickUnbind();
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        ...HEAD,
        GRANT_KEPT,
        '- 有 4 个任务做完了还没接受：解除之后再点接受，改动落不到项目里。可以先去任务页接受，或者之后重新绑定再接受。',
        ...TAIL,
      ].join('\n'),
    );
  });

  it('没有单独的授权：说没有可撤销的；只有要取消的那一行', async () => {
    api.previewUnbindProjectFolder.mockResolvedValue(preview({ grant: 'none', inFlightTasks: 1 }));
    confirm.mockReturnValue(false);
    await render();
    await clickUnbind();
    expect(confirm.mock.calls[0]![0]).toBe(
      [...HEAD, GRANT_NONE, '- 有 1 个编码任务正在排队或执行，会被取消。', ...TAIL].join('\n'),
    );
  });
});

describe('条件 11：取消确认', () => {
  it('不调 unbindProjectFolder，项目行不变，没有结果那句话，也不报错', async () => {
    confirm.mockReturnValue(false);
    await render();
    await clickUnbind();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.unbindProjectFolder).not.toHaveBeenCalled();
    expectStillBound();
    expect(q('project-unbind-result')).toBeNull();
    expect(q('error-banner')).toBeNull();
    // 取消之后还能再点（按钮没被卡在忙的状态）
    expect((q('project-unbind-folder-p1') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('条件 11：确认', () => {
  it('先预览、再问、确认了才解除；项目行变成没绑的样子；结果说撤销了、取消了几个', async () => {
    unbindSucceeds({ revokedPermissionId: 'grant-1', cancelledTaskIds: ['t1', 't2'] });
    await render();
    await clickUnbind();

    expect(calls).toEqual(['preview:p1', 'confirm', 'unbind:p1']);
    expect(api.unbindProjectFolder).toHaveBeenCalledWith('p1');
    expect(rowText('p1')).toContain('构想（未绑定目录）');
    expect(rowText('p1')).not.toContain(ROOT);
    expect(q('project-bind-folder-p1')?.textContent).toBe('绑定文件夹');
    expect(q('project-unbind-folder-p1')).toBeNull();
    expect(resultText()).toBe('已解除绑定。这个文件夹的读取授权已撤销。取消了2个编码任务。');
    expect(q('error-banner')).toBeNull();
    // 结果显示在被解除的那个项目自己的行里，页面上只有这一处
    expect(q('project-unbind-result')!.closest('[data-testid="project-row-p1"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="project-unbind-result"]')).toHaveLength(1);
  });

  it('接着解除另一个项目：结果那句话换到那个项目的行里', async () => {
    rows = [
      project('p1', '合成项目', ROOT),
      project('p3', '另一个项目', 'D:/synth/other'),
      project('p2', '只是构想', null),
    ];
    unbindSucceeds({ cancelledTaskIds: ['t1'] });
    await render();
    await clickUnbind('p1');
    expect(q('project-unbind-result')!.closest('[data-testid="project-row-p1"]')).not.toBeNull();
    expect(resultText()).toBe('已解除绑定。这个文件夹的读取授权已撤销。取消了1个编码任务。');

    unbindSucceeds({ revokedPermissionId: null });
    await clickUnbind('p3');
    const results = container.querySelectorAll('[data-testid="project-unbind-result"]');
    expect(results).toHaveLength(1);
    expect(results[0]!.closest('[data-testid="project-row-p3"]')).not.toBeNull();
    expect(resultText()).toBe('已解除绑定。读取授权没有撤销。');
    // 两个项目都成了没绑的样子
    expect(rowText('p1')).toContain('构想（未绑定目录）');
    expect(rowText('p3')).toContain('构想（未绑定目录）');
    expect(q('project-unbind-folder-p1')).toBeNull();
    expect(q('project-unbind-folder-p3')).toBeNull();
  });

  it('解除之后在同一页重新绑定：行里又是路径，那句「已解除绑定」不再显示', async () => {
    api.pickFiles.mockImplementation(async () => ({ ticket: 'ticket-1' }));
    api.bindProjectFolder.mockImplementation(async (input: { projectId: string }) => {
      rows = rows.map((p) => (p.id === input.projectId ? { ...p, root_path: ROOT } : p));
      return rows.find((p) => p.id === input.projectId)!;
    });
    await render();
    await clickUnbind();
    expect(resultText()).toBe('已解除绑定。这个文件夹的读取授权已撤销。');

    await act(async () => {
      (q('project-bind-folder-p1') as HTMLButtonElement).click();
    });
    await settle();
    expect(api.bindProjectFolder).toHaveBeenCalledWith({ ticket: 'ticket-1', projectId: 'p1' });
    expectStillBound();
    expect(q('project-unbind-result')).toBeNull();
    expect(q('error-banner')).toBeNull();
  });

  it('没撤销授权、没取消任务：结果照实说，不出现「取消了」', async () => {
    api.previewUnbindProjectFolder.mockResolvedValue(preview({ grant: 'kept_other_project' }));
    unbindSucceeds({ revokedPermissionId: null, cancelledTaskIds: [] });
    await render();
    await clickUnbind();

    expect(api.unbindProjectFolder).toHaveBeenCalledTimes(1);
    expect(resultText()).toBe('已解除绑定。读取授权没有撤销。');
    expect(rowText('p1')).toContain('构想（未绑定目录）');
  });

  it('撤销了授权、没取消任务：只有前两句', async () => {
    await render();
    await clickUnbind();
    expect(resultText()).toBe('已解除绑定。这个文件夹的读取授权已撤销。');
  });
});

describe('契约 7：出错显示在报错条里，项目行不变', () => {
  it('解除出错', async () => {
    api.unbindProjectFolder.mockImplementation(async () => {
      throw new Error('合成的解除失败');
    });
    await render();
    await clickUnbind();

    expect(q('error-banner')?.textContent).toContain('合成的解除失败');
    expectStillBound();
    expect(q('project-unbind-result')).toBeNull();
    expect((q('project-unbind-folder-p1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('预览出错：不问、不解除', async () => {
    api.previewUnbindProjectFolder.mockImplementation(async () => {
      throw new Error('合成的预览失败');
    });
    await render();
    await clickUnbind();

    expect(q('error-banner')?.textContent).toContain('合成的预览失败');
    expect(confirm).not.toHaveBeenCalled();
    expect(api.unbindProjectFolder).not.toHaveBeenCalled();
    expectStillBound();
    expect(q('project-unbind-result')).toBeNull();
  });
});
