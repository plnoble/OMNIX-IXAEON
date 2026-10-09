// @vitest-environment jsdom
/**
 * P7 验收（规格 docs/委派/P7-来源页撤销读取.md，条件 7–10 界面部分；条件 1–6、11、12 的库侧
 * 在 p7-preview-revoke.test.ts）。执行方写的，整合方 2026-10-09 锁定前改了一处写坏的
 * （取消那一条把记「问过了」的替身换掉了，自己就对不上），补了几处断言。
 *
 * - 详情卡片里「撤销读取」（data-testid="source-revoke-reading"）放在「重新分析」后面；
 * - 点了先调 previewRevokeSourceReading，按结果三选一：域名授权/有项目靠着 → 只显示
 *   source-revoke-note 一句话，不问、不撤销；其余用 window.confirm 问（文字照契约 4 逐字）；
 * - 取消确认什么都不发生；确认调 revokeSourceReading、详情卡片关掉、列表重新读一遍、
 *   结果句（source-revoke-result）数字对；预览说已经撤销 → 不问、不撤销、列表重读；
 * - 预览出错/撤销出错 → 报错条，详情卡片不关。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../../src/renderer/src/api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  listSources: vi.fn(),
  getSettings: vi.fn(),
  pickFiles: vi.fn(),
  listAgentSessions: vi.fn(),
  estimateAgentSessions: vi.fn(),
  importAgentSessions: vi.fn(),
  getSource: vi.fn(),
  getSourceSegments: vi.fn(),
  getSegmentContext: vi.fn(),
  bindSourceProject: vi.fn(),
  previewRevokeSourceReading: vi.fn(),
  revokeSourceReading: vi.fn(),
}));

vi.mock('../../src/renderer/src/api.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof ApiModule;
  return { ...actual, api: { ...actual.api, ...harness } };
});

import { SourcesPage } from '../../src/renderer/src/pages/Sources.js';

const projects = [{ id: 'p1', name: '合成项目一' }] as never;
const confirm = vi.fn<(message?: string) => boolean>();
const calls: string[] = [];

const FILE_PREVIEW = {
  scope: 'file',
  locator: 'D:/synth/a.md',
  status: 'active',
  sourcesUnderGrant: 2,
  dependentProjects: [],
} as const;
const FOLDER_PREVIEW = {
  scope: 'folder',
  locator: 'D:/synth/fold',
  status: 'active',
  sourcesUnderGrant: 3,
  dependentProjects: [],
} as const;

const sourceOf = (id: string) => ({
  id,
  kind: 'file',
  provider: 'local',
  account_namespace: 'local',
  external_id: id,
  title: '合成资料',
  content_hash: 'aa'.repeat(32),
  raw_path: 'sha256/aa/' + 'a'.repeat(64),
  captured_at: '2026-10-01T08:00:00.000Z',
  imported_at: '2026-10-01T08:00:00.000Z',
  permission_id: 'perm-' + id,
  project_id: null,
  metadata_json: null,
  archived_at: null,
  archive_summary: null,
});

const itemOf = (id: string, permissionStatus = 'active') => ({
  projectName: null,
  analysis: {
    contentRevision: 0,
    analyzedRevision: 0,
    analyzedAt: null,
    lastJobStatus: null,
    lastJobError: null,
    lastJobNote: null,
    lastJobAt: null,
    lastJobRetryCount: 0,
    lastJobNextAt: null,
  },
  source: sourceOf(id),
  permissionStatus,
  segmentCount: 1,
  itemCount: 0,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.length = 0;
  harness.listSources.mockReset().mockImplementation(async () => {
    calls.push('listSources');
    return [itemOf('s1')];
  });
  harness.getSettings.mockReset().mockImplementation(async () => ({
    config: { captureEnabled: true, autoAnalyze: false },
  }));
  harness.pickFiles.mockReset();
  harness.listAgentSessions.mockReset().mockImplementation(async () => []);
  harness.estimateAgentSessions.mockReset().mockImplementation(async () => ({
    items: [],
    userChars: 0,
    assistantChars: 0,
  }));
  harness.importAgentSessions.mockReset();
  harness.getSource.mockReset().mockImplementation(async (id: string) => sourceOf(id));
  harness.getSourceSegments
    .mockReset()
    .mockImplementation(async () => ({ segments: [], total: 0 }));
  harness.getSegmentContext.mockReset();
  harness.bindSourceProject.mockReset();
  harness.previewRevokeSourceReading.mockReset().mockImplementation(async (id: string) => {
    calls.push(`preview:${id}`);
    return { ...FILE_PREVIEW };
  });
  harness.revokeSourceReading.mockReset().mockImplementation(async (id: string) => {
    calls.push(`revoke:${id}`);
    return { id: 'perm-s1', status: 'revoked' };
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
      createElement(SourcesPage, {
        projects: projects as never,
        projectId: null,
        onProjectChange: () => undefined,
      }),
    );
  });
  await settle();
}

const $ = (testId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="${testId}"]`);

async function openDetail(id = 's1'): Promise<void> {
  await act(async () => {
    ($(`source-row-${id}`) as HTMLButtonElement).click();
  });
  await settle();
}

async function clickRevoke(): Promise<void> {
  await act(async () => {
    ($('source-revoke-reading') as HTMLButtonElement).click();
  });
  await settle();
}

describe('条件 7：可以撤销（文件 / 文件夹两版文字，逐字）', () => {
  it('「撤销读取」在详情卡片里，排在「重新分析」后面；没点之前不预览、不问', async () => {
    await render();
    expect($('source-revoke-reading')).toBeNull();
    await openDetail();
    const button = $('source-revoke-reading')!;
    expect(button.textContent).toBe('撤销读取');
    expect($('source-detail')!.contains(button)).toBe(true);
    expect(
      $('source-reanalyze')!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(harness.previewRevokeSourceReading).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('文件版：预览 → 问一遍 → 取消不调 revokeSourceReading', async () => {
    confirm.mockImplementation(() => {
      calls.push('confirm');
      return false;
    });
    await render();
    await openDetail();
    await clickRevoke();
    expect(calls).toEqual(['listSources', 'preview:s1', 'confirm']);
    expect(harness.revokeSourceReading).not.toHaveBeenCalled();
    expect($('source-detail')).not.toBeNull();
    expect($('source-revoke-result')).toBeNull();
    expect($('source-revoke-note')).toBeNull();
    expect($('error-banner')).toBeNull();
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        '撤销这个文件的读取授权？',
        '',
        'D:/synth/a.md',
        '',
        '撤销之后：',
        '- IXAEON 不再读它：这条授权下的 2 份资料不再读原文，已经提炼出的理解保留。',
        '- 要再用得重新导入。重新导入发的是一条新授权，现在这 2 份资料恢复不了。',
      ].join('\n'),
    );
  });

  it('文件夹版文字；确认之后：调了 revoke、详情关掉、列表重读、结果句数字对', async () => {
    harness.previewRevokeSourceReading.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return { ...FOLDER_PREVIEW };
    });
    await render();
    await openDetail();
    expect(confirm).not.toHaveBeenCalled();
    await clickRevoke();
    // 次序：先预览，再问，确认了才撤销，撤销之后才重读列表
    expect(calls).toEqual(['listSources', 'preview:s1', 'confirm', 'revoke:s1', 'listSources']);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toBe(
      [
        '撤销这个文件夹的读取授权？',
        '',
        'D:/synth/fold',
        '',
        '撤销之后：',
        '- IXAEON 不再读它：这条授权下的 3 份资料不再读原文，已经提炼出的理解保留。',
        '- 要再用得重新导入。重新导入发的是一条新授权，现在这 3 份资料恢复不了。',
      ].join('\n'),
    );
    expect(harness.revokeSourceReading).toHaveBeenCalledWith('s1');
    expect($('source-detail')).toBeNull();
    const result = $('source-revoke-result')?.textContent?.replace(/\s+/g, '');
    expect(result).toBe('已撤销读取授权：3份资料不再读原文。');
    expect(calls.filter((c) => c === 'listSources').length).toBe(2);
  });
});

describe('条件 8：不在这里撤的两种情况', () => {
  it('域名授权：只显示一句，不问、不撤销', async () => {
    harness.previewRevokeSourceReading.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return {
        scope: 'domain',
        locator: 'chatgpt.com',
        status: 'active',
        sourcesUnderGrant: 1,
        dependentProjects: [],
      };
    });
    await render();
    await openDetail();
    await clickRevoke();
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.revokeSourceReading).not.toHaveBeenCalled();
    expect($('source-revoke-note')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '这份资料不是读本机文件得来的（是网页采集或者保存的提问），没有本机的读取授权可撤。不想留着它，用「删除来源」。',
    );
  });

  it('有项目靠着：显示的那句带项目名（两个用「、」隔开），不问、不撤销', async () => {
    harness.previewRevokeSourceReading.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return {
        scope: 'folder',
        locator: 'D:/synth/fold',
        status: 'active',
        sourcesUnderGrant: 1,
        dependentProjects: ['甲项目', '乙项目'],
      };
    });
    await render();
    await openDetail();
    await clickRevoke();
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.revokeSourceReading).not.toHaveBeenCalled();
    expect($('source-revoke-note')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '项目「甲项目、乙项目」正靠这条授权读它的文件夹：到项目页对它点「解除绑定」，会一并撤销这个文件夹的读取授权。',
    );
    // 那句话在详情卡片里；详情不关，没有结果那句话
    expect($('source-detail')!.contains($('source-revoke-note'))).toBe(true);
    expect($('source-revoke-result')).toBeNull();
    expect($('error-banner')).toBeNull();
  });

  it('只有一个项目靠着：就写这一个名字', async () => {
    harness.previewRevokeSourceReading.mockImplementation(async () => ({
      scope: 'folder',
      locator: 'D:/synth/fold',
      status: 'active',
      sourcesUnderGrant: 4,
      dependentProjects: ['合成项目一'],
    }));
    await render();
    await openDetail();
    await clickRevoke();
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.revokeSourceReading).not.toHaveBeenCalled();
    expect($('source-revoke-note')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '项目「合成项目一」正靠这条授权读它的文件夹：到项目页对它点「解除绑定」，会一并撤销这个文件夹的读取授权。',
    );
  });
});

describe('条件 9：出错', () => {
  it('预览出错：不问、不撤销，报错条显示，详情不关', async () => {
    harness.previewRevokeSourceReading.mockImplementation(async () => {
      throw new Error('合成的预览失败');
    });
    await render();
    await openDetail();
    await clickRevoke();
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.revokeSourceReading).not.toHaveBeenCalled();
    expect($('error-banner')?.textContent).toContain('合成的预览失败');
    expect($('source-detail')).not.toBeNull();
    expect($('source-revoke-result')).toBeNull();
  });

  it('撤销出错：报错条显示，详情卡片不关', async () => {
    harness.revokeSourceReading.mockImplementation(async () => {
      throw new Error('合成的撤销失败');
    });
    await render();
    await openDetail();
    await clickRevoke();
    expect($('error-banner')?.textContent).toContain('合成的撤销失败');
    expect($('source-detail')).not.toBeNull();
    expect($('source-revoke-result')).toBeNull();
  });
});

describe('条件 10：预览说已经撤销', () => {
  it('不问、不撤销，列表重新读一遍', async () => {
    harness.previewRevokeSourceReading.mockImplementation(async (id: string) => {
      calls.push(`preview:${id}`);
      return { ...FILE_PREVIEW, status: 'revoked' };
    });
    await render();
    await openDetail();
    await clickRevoke();
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.revokeSourceReading).not.toHaveBeenCalled();
    expect(calls.filter((c) => c === 'listSources').length).toBe(2);
  });
});
