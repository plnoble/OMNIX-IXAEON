/**
 * P5 验收条件 11（规格 docs/委派/P5-解除项目的文件夹绑定.md）。界面，jsdom。
 * 实现还没有，现在应失败。
 */
// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  previewUnbindProjectFolder: vi.fn(),
  unbindProjectFolder: vi.fn(),
  listWorkRuns: vi.fn(async () => []),
}));
vi.mock('../../src/renderer/src/api.js', () => ({
  api: apiMock,
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

describe('P5 界面', () => {
  let container: HTMLDivElement;
  let root: Root;
  const confirm = vi.fn();

  beforeEach(() => {
    apiMock.listProjects.mockReset();
    apiMock.previewUnbindProjectFolder.mockReset();
    apiMock.unbindProjectFolder.mockReset();
    confirm.mockReset();
    vi.stubGlobal('confirm', confirm);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(): Promise<void> {
    const { ProjectsPage } = await import('../../src/renderer/src/pages/Projects.js');
    await act(async () => {
      root.render(createElement(ProjectsPage, { onOpenSources: () => undefined }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('条件 11：有绑定才有按钮；确认文字随数字和 grant 变；取消不调；确认后行和结果都变', async () => {
    const bound = { id: 'p1', name: '合成项目', status: 'active', root_path: 'D:/synth/repo' };
    const bare = { id: 'p2', name: '构想', status: 'active', root_path: null };
    apiMock.listProjects.mockResolvedValue([bound, bare]);
    apiMock.previewUnbindProjectFolder.mockResolvedValue({
      rootPath: bound.root_path,
      inFlightTasks: 2,
      pendingAcceptTasks: 0,
      sourcesUnderGrant: 3,
      grant: 'revoke',
    });
    await render();
    expect(container.querySelector('[data-testid="project-unbind-folder-p1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="project-unbind-folder-p2"]')).toBeNull();
    expect(container.textContent).toContain('构想（未绑定目录）');

    confirm.mockReturnValueOnce(false);
    await act(async () => {
      (
        container.querySelector('[data-testid="project-unbind-folder-p1"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    const asked = String(confirm.mock.calls[0]?.[0] ?? '');
    expect(asked).toContain('合成项目');
    expect(asked).toContain('D:/synth/repo');
    expect(asked).toContain('这个文件夹的读取授权一并撤销');
    expect(asked).toContain('3 份资料');
    expect(asked).toContain('2 个编码任务');
    expect(asked).not.toContain('还没接受');
    expect(apiMock.unbindProjectFolder).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    apiMock.unbindProjectFolder.mockResolvedValue({
      project: { ...bound, root_path: null },
      revokedPermissionId: 'grant-1',
      cancelledTaskIds: ['t1', 't2'],
    });
    apiMock.listProjects.mockResolvedValue([{ ...bound, root_path: null }, bare]);
    await act(async () => {
      (
        container.querySelector('[data-testid="project-unbind-folder-p1"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMock.unbindProjectFolder).toHaveBeenCalledWith('p1');
    const row = container.querySelector('[data-testid="project-row-p1"]')!.textContent!;
    expect(row).toContain('构想（未绑定目录）');
    expect(row).toContain('绑定文件夹');
    const result = container.querySelector('[data-testid="project-unbind-result"]')!.textContent!;
    expect(result).toContain('已解除绑定');
    expect(result).toContain('读取授权已撤销');
    expect(result).toContain('取消了 2 个编码任务');
  });

  it('条件 11：授权留着、没有可撤销的，确认文字和结果跟着变', async () => {
    apiMock.listProjects.mockResolvedValue([
      { id: 'p1', name: '合成项目', status: 'active', root_path: 'D:/synth/repo' },
    ]);
    apiMock.previewUnbindProjectFolder.mockResolvedValue({
      rootPath: 'D:/synth/repo',
      inFlightTasks: 0,
      pendingAcceptTasks: 1,
      sourcesUnderGrant: 0,
      grant: 'kept_other_project',
    });
    await render();
    confirm.mockReturnValueOnce(false);
    await act(async () => {
      (
        container.querySelector('[data-testid="project-unbind-folder-p1"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    const kept = String(confirm.mock.calls[0]?.[0] ?? '');
    expect(kept).toContain('另一个项目也绑着这个文件夹');
    expect(kept).toContain('1 个任务做完了还没接受');
    expect(kept).not.toContain('正在排队或执行');
    expect(kept).not.toContain('份资料');

    apiMock.previewUnbindProjectFolder.mockResolvedValue({
      rootPath: 'D:/synth/repo',
      inFlightTasks: 0,
      pendingAcceptTasks: 0,
      sourcesUnderGrant: 0,
      grant: 'none',
    });
    confirm.mockReturnValueOnce(true);
    apiMock.unbindProjectFolder.mockResolvedValue({
      project: { id: 'p1', name: '合成项目', status: 'active', root_path: null },
      revokedPermissionId: null,
      cancelledTaskIds: [],
    });
    apiMock.listProjects.mockResolvedValue([
      { id: 'p1', name: '合成项目', status: 'active', root_path: null },
    ]);
    await act(async () => {
      (
        container.querySelector('[data-testid="project-unbind-folder-p1"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(String(confirm.mock.calls[1]?.[0] ?? '')).toContain('没有单独的读取授权');
    const result = container.querySelector('[data-testid="project-unbind-result"]')!.textContent!;
    expect(result).toContain('读取授权没有撤销');
    expect(result).not.toContain('取消了');
  });
});
