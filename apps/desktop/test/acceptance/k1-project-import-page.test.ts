// @vitest-environment jsdom
/**
 * K1 界面验收（规格 docs/委派/K1-项目清单导入.md 契约最后一条）：
 * 项目页标题栏有「从清单导入」；选 JSON 后弹预览；「确认导入」才写入并刷新列表；
 * 取消什么都不写。预览里的新增 / 变化 / 不变 / 无效条数和无效原因都要看得见。
 *
 * 条件 1 的核心口径（确认前库不变）在 packages/core/test/acceptance/k1-project-import.test.ts；
 * 这一页只负责：不点确认就不调 apply，列表不重读。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectImportPlan } from '@ixaeon/contracts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listWorkRuns: vi.fn(async () => []),
  pickFiles: vi.fn(),
  previewProjectImport: vi.fn(),
  applyProjectImport: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', () => ({
  api,
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { ProjectsPage } from '../../src/renderer/src/pages/Projects.js';

const project = (id: string, name: string, status: Project['status']): Project =>
  ({
    id,
    name,
    root_path: null,
    description: null,
    status,
    created_at: '2026-10-01T08:00:00.000Z',
    updated_at: '2026-10-01T08:00:00.000Z',
    purpose: null,
    current_state: null,
    primary_io: null,
    capabilities: null,
    related_goals: null,
    unknowns: null,
  }) as Project;

const previewPlan = (): ProjectImportPlan => ({
  create: [{ name: '合成新项目', status: 'paused', note: '清单里的备注' }],
  update: [{ project: project('p1', '合成甲', 'active'), status: 'archived' }],
  unchanged: [project('p2', '合成乙', 'paused')],
  invalid: [
    { index: 3, name: '坏条目', reason: 'status 不合法（只能是 active / paused / archived）' },
  ],
});

/** 已有项目的 note 由主进程按项目名另给（plan 里只有新增条目带 note），要和对应行一起显示。 */
const previewNotes = () => ({
  合成甲: '变化行的备注',
  合成乙: '不变行的备注',
});

let container: HTMLDivElement;
let root: Root;
let rows: Project[];
const onChanged = vi.fn();

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  rows = [project('p1', '合成甲', 'active'), project('p2', '合成乙', 'paused')];
  api.listProjects.mockReset().mockImplementation(async () => rows.map((p) => ({ ...p })));
  api.listWorkRuns.mockReset().mockResolvedValue([]);
  api.pickFiles
    .mockReset()
    .mockResolvedValue({ ticket: 'ticket-1', paths: ['D:/synth/list.json'] });
  api.previewProjectImport
    .mockReset()
    .mockResolvedValue({ token: 'preview-1', preview: previewPlan(), notes: previewNotes() });
  api.applyProjectImport.mockReset().mockImplementation(async () => {
    rows = [...rows, project('p3', '合成新项目', 'paused')];
    rows = rows.map((p) => (p.id === 'p1' ? { ...p, status: 'archived' } : p));
    return { created: 1, updated: 1 };
  });
  onChanged.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderPage = async (): Promise<void> => {
  await act(async () => {
    root.render(createElement(ProjectsPage, { onOpenSources: () => undefined, onChanged }));
  });
  await settle();
};

const click = async (testId: string): Promise<void> => {
  const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  if (!el) throw new Error(`找不到 ${testId}`);
  await act(async () => {
    el.click();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
};

describe('K1 项目页从清单导入', () => {
  it('标题栏有按钮；选了清单先弹预览，条数、无效原因都在', async () => {
    await renderPage();
    expect(container.querySelector('[data-testid="projects-import"]')).not.toBeNull();

    await click('projects-import');

    expect(api.pickFiles).toHaveBeenCalledWith('documents');
    expect(api.previewProjectImport).toHaveBeenCalledWith({ ticket: 'ticket-1' });
    const dialog = container.querySelector('[data-testid="project-import-preview"]');
    expect(dialog).not.toBeNull();
    expect(container.querySelector('[data-testid="project-import-counts"]')!.textContent).toContain(
      '新增 1 个、变化 1 个、不变 1 个、无效 1 个',
    );
    expect(container.querySelector('[data-testid="project-import-create"]')!.textContent).toContain(
      '清单里的备注',
    );
    expect(container.querySelector('[data-testid="project-import-update"]')!.textContent).toContain(
      '进行中 → 放弃',
    );
    expect(container.querySelector('[data-testid="project-import-update"]')!.textContent).toContain(
      '变化行的备注',
    );
    expect(
      container.querySelector('[data-testid="project-import-unchanged"]')!.textContent,
    ).toContain('不变行的备注');
    expect(
      container.querySelector('[data-testid="project-import-invalid"]')!.textContent,
    ).toContain('status 不合法');
    // 只预览：库没写，列表没重读
    expect(api.applyProjectImport).not.toHaveBeenCalled();
    expect(api.listProjects).toHaveBeenCalledTimes(1);
  });

  it('取消：不写入，列表不刷新', async () => {
    await renderPage();
    await click('projects-import');
    await click('project-import-cancel');

    expect(api.applyProjectImport).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="project-import-preview"]')).toBeNull();
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('确认导入：按预览凭证写入、刷新列表、显示结果', async () => {
    await renderPage();
    await click('projects-import');
    await click('project-import-confirm');

    expect(api.applyProjectImport).toHaveBeenCalledWith({ token: 'preview-1' });
    expect(api.listProjects).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="project-import-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-import-result"]')!.textContent).toContain(
      '新增 1 个项目，更新 1 个状态',
    );
    expect(container.textContent).toContain('合成新项目');
  });

  it('确认失败（凭证过期）：关掉失效预览、显示原因，不再让人重复点确认', async () => {
    api.applyProjectImport.mockRejectedValueOnce(new Error('预览凭证已过期（请重新选择清单）'));
    await renderPage();
    await click('projects-import');
    await click('project-import-confirm');

    expect(api.applyProjectImport).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="project-import-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-import-confirm"]')).toBeNull();
    expect(container.textContent).toContain('预览凭证已过期');
  });

  it('选到的不是 JSON：报错，不调预览', async () => {
    api.pickFiles.mockResolvedValue({ ticket: 'ticket-1', paths: ['D:/synth/notes.md'] });
    await renderPage();
    await click('projects-import');

    expect(api.previewProjectImport).not.toHaveBeenCalled();
    expect(container.textContent).toContain('.json');
  });

  // 整合方复审补：备注只认 notes 自己的键，项目名恰好是原型上的名字时不能显示出原型成员
  it('项目名叫 constructor / toString、清单没给备注：预览里不显示备注', async () => {
    api.previewProjectImport.mockResolvedValue({
      token: 'preview-1',
      preview: {
        create: [],
        update: [{ project: project('p8', 'toString', 'active'), status: 'paused' }],
        unchanged: [project('p9', 'constructor', 'paused')],
        invalid: [],
      },
      notes: {},
    });
    await renderPage();
    await click('projects-import');

    expect(container.querySelector('[data-testid="project-import-update"] .muted')).toBeNull();
    expect(container.querySelector('[data-testid="project-import-unchanged"] .muted')).toBeNull();
  });
});
