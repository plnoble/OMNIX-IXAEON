/**
 * P7 验收（规格 docs/委派/P7-来源页撤销读取.md，条件 1–6、11、12；界面的条件 7–10 在
 * p7-revoke-page.test.ts）。执行方先推了一版，整合方 2026-10-09 锁定前重写
 * （规格末尾「整合方审测试时的改正与补充」）。
 *
 * 钉住的接缝：
 * - `AppRuntime.previewRevokeSourceReading(sourceId)`，只读，返回恰好五项
 *   `{ scope, locator, status, sourcesUnderGrant, dependentProjects }`；
 * - 资料不存在报「来源不存在」；
 * - `dependentProjects`：绑着文件夹的项目（不管什么状态）里，文件夹在这条授权之内、
 *   而且除了这一条之外没有别的有效授权覆盖它的，按名字排序；文件授权、域名授权、
 *   已经撤销的授权都是空的。
 *
 * 原版里写坏的（改掉了）：文件末尾用了几个没引入的名字，整份文件一加载就报错，实现写对了
 * 也是全红；条件 1 把资料归到一个不存在的项目上，库里的外键不让插；条件 12 说「条目一条不少」
 * 却没有建条目。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  FakeProvider,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import type { Project } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}));

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p7-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(async () => {
  if (db.open) db.close();
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

interface Harness {
  runtime: AppRuntime;
  projects: ProjectService;
  permissions: PermissionService;
  sources: SourceStore;
  items: ItemService;
}

function setup(): Harness {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  const projects = new ProjectService(db);
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const items = new ItemService(db);
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    projects,
    permissions,
    sources,
    items,
    conversations: new ConversationStore(db),
    todos: new TodoStore(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data')),
    search: new SearchService(db),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('p7'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger,
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return { runtime, projects, permissions, sources, items };
}

/** 往一条授权下放一份资料（projectId 是 null = 没归到哪个项目）。返回来源号。 */
function sourceUnder(h: Harness, permissionId: string, projectId: string | null): string {
  return h.sources.insertParsed(
    {
      kind: 'project_snapshot',
      provider: 'project',
      accountNamespace: 'local',
      externalId: randomUUID(),
      title: '合成资料',
      contentHash: randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
      capturedAt: '2026-10-01T08:00:00.000Z',
      importMethod: 'project_snapshot',
      segments: [
        {
          sequence: 0,
          role: 'document',
          externalNodeId: null,
          externalParentId: null,
          isActiveBranch: true,
          occurredAt: '2026-10-01T08:00:00.000Z',
          text: '合成的资料正文',
          metadata: {},
        },
      ],
      metadata: {},
    },
    { permissionId, projectId, rawPath: `sha256/aa/${'a'.repeat(64)}` },
  ).id;
}

/** 一条从这份资料提炼出来的条目。返回条目号。 */
function itemFrom(h: Harness, sourceId: string, projectId: string): string {
  const item = h.items.createManual({
    projectId,
    type: 'decision',
    statement: '从合成资料里提炼出的一条',
    rationale: null,
  });
  db.prepare('UPDATE items SET extracted_from_source_id = ? WHERE id = ?').run(sourceId, item.id);
  return item.id;
}

/** 合成的文件夹（里面一个文件）。 */
function folder(...parts: string[]): string {
  const f = join(dir, 'syn', ...parts);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, 'note.txt'), '合成文件\n');
  return f;
}

/** 新建项目并用真的 bindProjectFolder 绑上文件夹（会发这个文件夹自己的授权）。 */
async function bound(h: Harness, name: string, root: string): Promise<Project> {
  const created = h.projects.create({ name, rootPath: null, description: null });
  return h.runtime.bindProjectFolder(created.id, root);
}

const ownGrantId = (h: Harness, root: string) => h.permissions.activePermissionForPath(root)!.id;
const count = (table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = () => ({
  permissions: db.prepare('SELECT id, status, revoked_at FROM permissions ORDER BY id').all(),
  projects: db.prepare('SELECT id, root_path, status FROM projects ORDER BY id').all(),
  sources: db.prepare('SELECT id, permission_id, project_id FROM sources ORDER BY id').all(),
  audits: count('audit_events'),
  items: count('items'),
});
const sourceGrantStatus = (h: Harness, sourceId: string) =>
  h.sources.list({ projectId: null }).find((s) => s.source.id === sourceId)?.permissionStatus;

describe('条件 1：导入文档得来的资料（文件授权）', () => {
  it('scope 是 file、locator 是那个文件、有效；同一个文件下的资料都算；没有靠着它的项目', async () => {
    const h = setup();
    const file = join(folder('docs'), 'note.txt');
    const grant = h.permissions.grantFile(file);
    const project = h.projects.create({ name: '合成项目', rootPath: null, description: null });
    const first = sourceUnder(h, grant.id, null);
    sourceUnder(h, grant.id, project.id);
    // 别的授权下的资料不算
    sourceUnder(h, h.permissions.grantFile(join(folder('other'), 'note.txt')).id, null);

    expect(await h.runtime.previewRevokeSourceReading(first)).toEqual({
      scope: 'file',
      locator: grant.locator,
      status: 'active',
      sourcesUnderGrant: 2,
      dependentProjects: [],
    });
  });
});

describe('条件 2：导入文件夹得来的资料（这个文件夹没绑在项目上）', () => {
  it('scope 是 folder；归在别的项目的、没归项目的资料都算；没有靠着它的项目', async () => {
    const h = setup();
    const grant = h.permissions.grantFolder(folder('imported'));
    const one = h.projects.create({ name: '项目一', rootPath: null, description: null });
    const two = h.projects.create({ name: '项目二', rootPath: null, description: null });
    const first = sourceUnder(h, grant.id, one.id);
    sourceUnder(h, grant.id, two.id);
    sourceUnder(h, grant.id, null);

    expect(await h.runtime.previewRevokeSourceReading(first)).toEqual({
      scope: 'folder',
      locator: grant.locator,
      status: 'active',
      sourcesUnderGrant: 3,
      dependentProjects: [],
    });
  });
});

describe('条件 3：这个文件夹正绑在项目上', () => {
  it('项目没有别的授权：dependentProjects 是这个项目的名字；项目归档了也算', async () => {
    const h = setup();
    const root = folder('bound');
    const project = await bound(h, '绑着的项目', root);
    const source = sourceUnder(h, ownGrantId(h, root), project.id);

    expect((await h.runtime.previewRevokeSourceReading(source)).dependentProjects).toEqual([
      '绑着的项目',
    ]);
    h.projects.updateStatus(project.id, 'archived');
    expect((await h.runtime.previewRevokeSourceReading(source)).dependentProjects).toEqual([
      '绑着的项目',
    ]);
  });

  it('没绑文件夹的项目、绑在别处的项目不算', async () => {
    const h = setup();
    const grant = h.permissions.grantFolder(folder('imported'));
    h.projects.create({ name: '没绑的项目', rootPath: null, description: null });
    await bound(h, '绑在别处的项目', folder('elsewhere'));
    // 绑在别处、那边的授权又撤销了的：它现在没有任何授权，但也不在这条授权里，不算靠着这一条
    await bound(h, '别处授权也没了的项目', folder('nowhere'));
    h.permissions.revoke(ownGrantId(h, folder('nowhere')));
    const source = sourceUnder(h, grant.id, null);

    expect((await h.runtime.previewRevokeSourceReading(source)).dependentProjects).toEqual([]);
  });
});

describe('条件 4：这条授权是项目文件夹的上级文件夹', () => {
  it('项目自己另有有效授权的不算；自己那条撤销了的算；两个都靠着时按名字排序', async () => {
    const h = setup();
    const parent = folder('parent');
    const upper = h.permissions.grantFolder(parent);
    // 名字故意倒着建：排序要看名字，不是看建的先后
    await bound(h, 'B 项目', folder('parent', 'b'));
    await bound(h, 'A 项目', folder('parent', 'a'));
    const source = sourceUnder(h, upper.id, null);
    const deps = async () => (await h.runtime.previewRevokeSourceReading(source)).dependentProjects;

    // 两个项目都有自己的授权：上级这一条撤了也不碍它们
    expect(await deps()).toEqual([]);
    h.permissions.revoke(ownGrantId(h, join(parent, 'b')));
    // 现在 parent/b 只在上级这条授权之内
    expect(await deps()).toEqual(['B 项目']);
    h.permissions.revoke(ownGrantId(h, join(parent, 'a')));
    expect(await deps()).toEqual(['A 项目', 'B 项目']);
  });
});

describe('条件 5：域名授权下的资料', () => {
  it('scope 是 domain、locator 是域名、没有靠着它的项目', async () => {
    const h = setup();
    const grant = h.permissions.grantDomain('chatgpt.com');
    const source = sourceUnder(h, grant.id, null);

    expect(await h.runtime.previewRevokeSourceReading(source)).toEqual({
      scope: 'domain',
      locator: 'chatgpt.com',
      status: 'active',
      sourcesUnderGrant: 1,
      dependentProjects: [],
    });
  });
});

describe('契约 2：已经撤销的授权', () => {
  it('status 是 revoked；即使有项目绑着这个文件夹，dependentProjects 也是空的', async () => {
    const h = setup();
    const root = folder('bound');
    const project = await bound(h, '绑着的项目', root);
    const grantId = ownGrantId(h, root);
    const source = sourceUnder(h, grantId, project.id);
    h.permissions.revoke(grantId);

    expect(await h.runtime.previewRevokeSourceReading(source)).toEqual({
      scope: 'folder',
      locator: h.permissions.get(grantId)!.locator,
      status: 'revoked',
      sourcesUnderGrant: 1,
      dependentProjects: [],
    });
  });
});

describe('条件 6：预览只读', () => {
  it('调用前后授权、项目、资料、审计都不变；正在用的对话上下文没有被作废；资料不存在时拒绝', async () => {
    const h = setup();
    const root = folder('bound');
    const project = await bound(h, '绑着的项目', root);
    const source = sourceUnder(h, ownGrantId(h, root), project.id);
    const before = snapshot();
    const invalidate = vi.fn();
    const sessions = (h.runtime as unknown as { askSessions: Map<string, unknown> }).askSessions;
    sessions.set('合成会话', { invalidateContext: invalidate });

    await h.runtime.previewRevokeSourceReading(source);
    await h.runtime.previewRevokeSourceReading(source);
    expect(snapshot()).toEqual(before);
    expect(invalidate).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);

    await expect(h.runtime.previewRevokeSourceReading('no-such-source')).rejects.toThrow(
      '来源不存在',
    );
    expect(snapshot()).toEqual(before);
  });
});

describe('条件 11：IPC', () => {
  it('registerIpc 注册了 previewRevokeSourceReading，调它得到的和运行时上的方法一样', async () => {
    const h = setup();
    const grant = h.permissions.grantFolder(folder('imported'));
    const source = sourceUnder(h, grant.id, null);
    sourceUnder(h, grant.id, null);
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'ixaeon:previewRevokeSourceReading');
    if (!entry) throw new Error('没有注册 IPC：previewRevokeSourceReading');

    const viaIpc = await entry[1]({} as never, source);
    expect(viaIpc).toEqual(await h.runtime.previewRevokeSourceReading(source));
    expect(viaIpc).toMatchObject({ scope: 'folder', status: 'active', sourcesUnderGrant: 2 });
    // 调的是预览，不是撤销
    expect(h.permissions.get(grant.id)!.status).toBe('active');
    await expect(entry[1]({} as never, 'no-such-source')).rejects.toThrow('来源不存在');
  });
});

describe('条件 12：照界面那条路撤销之后（预览 → revokeSourceReading）', () => {
  it('这条授权 revoked；它下面的资料都是已撤销、资料和条目一条不少；别的授权下的资料不受影响；上下文作废了', async () => {
    const h = setup();
    const grant = h.permissions.grantFolder(folder('imported'));
    const project = h.projects.create({ name: '合成项目', rootPath: null, description: null });
    const first = sourceUnder(h, grant.id, project.id);
    const second = sourceUnder(h, grant.id, null);
    const itemId = itemFrom(h, first, project.id);
    const elsewhere = sourceUnder(h, h.permissions.grantFolder(folder('other')).id, null);
    const invalidate = vi.fn();
    (h.runtime as unknown as { askSessions: Map<string, unknown> }).askSessions.set('合成会话', {
      invalidateContext: invalidate,
    });

    const preview = await h.runtime.previewRevokeSourceReading(first);
    expect(preview).toMatchObject({
      status: 'active',
      sourcesUnderGrant: 2,
      dependentProjects: [],
    });
    const before = { sources: count('sources'), items: count('items') };
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const revoke = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'ixaeon:revokeSourceReading');
    if (!revoke) throw new Error('没有注册 IPC：revokeSourceReading');
    await revoke[1]({} as never, first);

    expect(h.permissions.get(grant.id)!.status).toBe('revoked');
    expect(sourceGrantStatus(h, first)).toBe('revoked');
    expect(sourceGrantStatus(h, second)).toBe('revoked');
    expect(sourceGrantStatus(h, elsewhere)).toBe('active');
    expect({ sources: count('sources'), items: count('items') }).toEqual(before);
    expect(h.sources.countItems(first)).toBe(1);
    expect(h.items.get(itemId).statement).toBe('从合成资料里提炼出的一条');
    expect(invalidate).toHaveBeenCalled();
    // 撤销之后再预览：说已经撤销了
    expect((await h.runtime.previewRevokeSourceReading(first)).status).toBe('revoked');
  });
});
