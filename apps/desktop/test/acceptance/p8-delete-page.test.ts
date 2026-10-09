// @vitest-environment jsdom
/**
 * P8 验收条件 10（规格 docs/委派/P8-删除项目时撤销授权并清副本.md，契约 4）：
 * 项目页「删除」的确认框与结果。执行方先推了一版，整合方 2026-10-09 锁定前改写
 * （规格末尾「整合方审测试时的改正与补充」）：原版有三条是测试自己对不上——点的是另一个
 * 项目却核对这个项目的名字；默认确认是「确定」却只数到问为止；确认框里少了一个空行。
 *
 * - 绑着文件夹的：点了先调 previewUnbindProjectFolder，再用 window.confirm 问；没绑的不调预览，直接问。
 * - 确认框文字逐字：第一段是原来的话加了一句副本；「这个项目绑着文件夹：」那一段只在绑着时出现，
 *   和第一段之间空一行；讲授权的那一行三选一，都以「- 」开头；带数字的两行数字是 0 就不出现。
 * - 取消确认不调 deleteProject；确认之后调了、列表重新读过、结果那句话（project-delete-result，
 *   在项目列表上面）如实：四种成分各自有没有。
 * - 出错显示在报错条里；预览出错时不问、不删。
 *
 * 这一页在这些操作里只用到 listProjects、listWorkRuns、previewUnbindProjectFolder、deleteProject。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeleteProjectResult, Project, UnbindProjectFolderPreview } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listWorkRuns: vi.fn(async () => []),
  previewUnbindProjectFolder: vi.fn(),
  deleteProject: vi.fn(),
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

/** 确认框的前两段（没绑文件夹的项目只有这两段）。 */
const head = (name: string): string[] => [
  `删除项目「${name}」？`,
  '',
  '属于该项目的理解、关系、编码任务会删除，编码任务的隔离副本（里面有当时的项目文件）也一并删掉。来源会变成未归属，对话原文保留。个人记忆不动。此操作不能从列表撤销（可用备份恢复）。',
];
/** 绑着文件夹时多出来的那一段的开头（和前面空一行）。 */
const BOUND = ['', '这个项目绑着文件夹：', ROOT];
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

/** deleteProject 成功：库里也跟着没了这个项目。 */
function deleteSucceeds(patch: Partial<DeleteProjectResult> = {}): void {
  api.deleteProject.mockImplementation(async (id: string) => {
    calls.push(`delete:${id}`);
    rows = rows.filter((p) => p.id !== id);
    return {
      sourcesUnassigned: 0,
      itemsRemoved: 0,
      revokedPermissionId: null,
      cancelledTasks: 0,
      copiesRemoved: 0,
      copiesLeft: 0,
      ...patch,
    } satisfies DeleteProjectResult;
  });
}

const confirmAnswers = (answer: boolean): void => {
  confirm.mockReset().mockImplementation(() => {
    calls.push('confirm');
    return answer;
  });
};

beforeEach(() => {
  calls.length = 0;
  rows = [project('p1', '合成项目', ROOT), project('p2', '只是构想', null)];
  api.listProjects.mockReset().mockImplementation(async () => {
    calls.push('list');
    return rows.map((p) => ({ ...p }));
  });
  api.listWorkRuns.mockClear();
  api.previewUnbindProjectFolder.mockReset().mockImplementation(async (id: string) => {
    calls.push(`preview:${id}`);
    return preview();
  });
  api.deleteProject.mockReset();
  deleteSucceeds();
  confirmAnswers(true);
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
/** 结果那句话（不计较句子之间的空白）。 */
const resultText = (): string | null =>
  q('project-delete-result')?.textContent?.replace(/\s+/g, '') ?? null;

async function clickDelete(id = 'p1'): Promise<void> {
  const button = q(`project-delete-${id}`);
  expect(button, `项目 ${id} 的「删除」按钮`).not.toBeNull();
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
  await settle();
}

describe('条件 10：确认框的文字', () => {
  it('没绑文件夹的项目：不调预览，确认框只有前两段', async () => {
    confirmAnswers(false);
    await render();
    await clickDelete('p2');

    expect(api.previewUnbindProjectFolder).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toBe(head('只是构想').join('\n'));
  });

  it('绑着、授权会撤销、两个数字都不是 0：先预览再问；整段一字不差', async () => {
    api.previewUnbindProjectFolder.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return preview({ sourcesUnderGrant: 3, inFlightTasks: 2, pendingAcceptTasks: 4 });
    });
    confirmAnswers(false);
    await render();
    await clickDelete();

    expect(calls).toEqual(['list', 'preview:p1', 'confirm']);
    expect(api.previewUnbindProjectFolder).toHaveBeenCalledWith('p1');
    // 等接受的任务数不进确认框（任务反正跟着项目删）
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        ...head('合成项目'),
        ...BOUND,
        GRANT_REVOKE,
        '- 这条授权下导入过 3 份资料：之后不再读它们的原文。',
        '- 有 2 个编码任务正在排队或执行，会被取消。',
      ].join('\n'),
    );
  });

  it('数字是 0 的行不出现', async () => {
    confirmAnswers(false);
    await render();
    await clickDelete();
    expect(confirm.mock.calls[0]![0]).toBe(
      [...head('合成项目'), ...BOUND, GRANT_REVOKE].join('\n'),
    );
  });

  it('别的项目也绑着：说不撤销；只有资料那一行', async () => {
    api.previewUnbindProjectFolder.mockResolvedValue(
      preview({ grant: 'kept_other_project', sourcesUnderGrant: 5 }),
    );
    confirmAnswers(false);
    await render();
    await clickDelete();
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        ...head('合成项目'),
        ...BOUND,
        GRANT_KEPT,
        '- 这条授权下导入过 5 份资料：之后不再读它们的原文。',
      ].join('\n'),
    );
  });

  it('没有单独的授权：说没有可撤销的；只有要取消的那一行', async () => {
    api.previewUnbindProjectFolder.mockResolvedValue(preview({ grant: 'none', inFlightTasks: 1 }));
    confirmAnswers(false);
    await render();
    await clickDelete();
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        ...head('合成项目'),
        ...BOUND,
        GRANT_NONE,
        '- 有 1 个编码任务正在排队或执行，会被取消。',
      ].join('\n'),
    );
  });
});

describe('条件 10：取消确认', () => {
  it('不调 deleteProject，项目行还在，没有结果那句话，也不报错；按钮还能再点', async () => {
    confirmAnswers(false);
    await render();
    await clickDelete();

    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(q('project-row-p1')).not.toBeNull();
    expect(q('project-delete-result')).toBeNull();
    expect(q('error-banner')).toBeNull();
    expect((q('project-delete-p1') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('条件 10：确认', () => {
  it('先预览、再问、确认了才删、删完重新读列表；结果那句话四种成分都在', async () => {
    deleteSucceeds({
      revokedPermissionId: 'grant-1',
      cancelledTasks: 2,
      copiesRemoved: 3,
      copiesLeft: 1,
    });
    await render();
    await clickDelete();

    expect(calls).toEqual(['list', 'preview:p1', 'confirm', 'delete:p1', 'list']);
    expect(api.deleteProject).toHaveBeenCalledWith('p1');
    expect(q('project-row-p1')).toBeNull();
    expect(q('project-row-p2')).not.toBeNull();
    expect(resultText()).toBe(
      '已删除项目「合成项目」。这个文件夹的读取授权已撤销。取消了2个编码任务。有1个任务副本没删掉（文件正被占用），还在数据目录的workspaces里。',
    );
    // 结果那句话在项目列表上面
    const result = q('project-delete-result')!;
    expect(
      result.compareDocumentPosition(q('project-row-p2')!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(q('error-banner')).toBeNull();
  });

  it('没撤销、没取消、副本都删掉了：结果只有第一句', async () => {
    deleteSucceeds({ copiesRemoved: 2 });
    await render();
    await clickDelete();
    expect(resultText()).toBe('已删除项目「合成项目」。');
  });

  it('只撤销了授权 / 只取消了任务：各接各的那一句', async () => {
    deleteSucceeds({ revokedPermissionId: 'grant-1' });
    await render();
    await clickDelete();
    expect(resultText()).toBe('已删除项目「合成项目」。这个文件夹的读取授权已撤销。');

    rows = [project('p3', '另一个项目', ROOT)];
    deleteSucceeds({ cancelledTasks: 1 });
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render();
    await clickDelete('p3');
    expect(resultText()).toBe('已删除项目「另一个项目」。取消了1个编码任务。');
  });

  it('没绑文件夹的项目：不预览，确认了照样删、照样有结果那句话', async () => {
    await render();
    await clickDelete('p2');

    expect(calls).toEqual(['list', 'confirm', 'delete:p2', 'list']);
    expect(q('project-row-p2')).toBeNull();
    expect(resultText()).toBe('已删除项目「只是构想」。');
  });
});

describe('契约 4：出错显示在报错条里', () => {
  it('预览出错：不问、不删，项目行还在', async () => {
    api.previewUnbindProjectFolder.mockImplementation(async () => {
      throw new Error('合成的预览失败');
    });
    await render();
    await clickDelete();

    expect(q('error-banner')?.textContent).toContain('合成的预览失败');
    expect(confirm).not.toHaveBeenCalled();
    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(q('project-row-p1')).not.toBeNull();
    expect(q('project-delete-result')).toBeNull();
  });

  it('删除出错：项目行还在，没有结果那句话，按钮还能再点', async () => {
    api.deleteProject.mockImplementation(async () => {
      throw new Error('合成的删除失败');
    });
    await render();
    await clickDelete();

    expect(q('error-banner')?.textContent).toContain('合成的删除失败');
    expect(q('project-row-p1')).not.toBeNull();
    expect(q('project-delete-result')).toBeNull();
    expect((q('project-delete-p1') as HTMLButtonElement).disabled).toBe(false);
  });
});
