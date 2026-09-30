/**
 * P4 验收测试（规格 docs/委派/P4-给项目绑定文件夹.md，v2 写法：先测试后实现）。
 * 逐条对应验收条件 1–6（条件 7「只收票据」由真机检查第 2 步验证，见文件头注释末尾）。实现前应失败。
 *
 * 钉住的接缝（实现必须兼容）：
 * - `AppRuntime.bindProjectFolder(projectId, folderPath)`：业务逻辑放这里，
 *   IPC 只负责消费票据后调它；返回更新后的项目（含 root_path）；
 * - `AppRuntime.approveCodingTask(taskId)`：任务页「批准」改走这个带检查的方法；
 * - 拦三处入口的报错文案（逐字）：「这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。」
 * - `hermesTool('propose_coding_task', …)` 在没绑文件夹的项目对话上 → rejects 同一条文案；
 * - `acceptTodo` / `approveCodingTask` 在没绑文件夹的项目上 → rejects 同一条文案，
 *   任务与待办都不动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type CoreDatabase,
} from '@ixaeon/core';
import { AppRuntime } from '../../src/main/appRuntime.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

export const UNBOUND_MESSAGE = '这个项目还没绑定文件夹：先在项目页点「绑定文件夹」，再派编码任务。';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-p4-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function folder(label: string): string {
  const f = join(dir, label);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, 'note.txt'), '合成文件');
  return f;
}

function setup() {
  const modelCalls = { count: 0 };
  const provider = {
    chat: vi.fn(async () => {
      modelCalls.count += 1;
      return {
        answer: 'fake',
        citations: [],
        notice: '',
        usedChars: 1,
        modelName: 'p4',
        engine: 'fake',
      };
    }),
    chatStructured: vi.fn(async () => {
      modelCalls.count += 1;
      return {};
    }),
  };
  const projects = new ProjectService(db);
  const permissions = new PermissionService(db);
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const coding = new CodingOrchestrator(db, new FakeCodingExecutor(), join(dir, 'data'));
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    projects,
    permissions,
    conversations,
    todos,
    coding,
    items: new ItemService(db),
    search: new SearchService(db),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => provider,
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return { runtime, projects, permissions, conversations, todos, coding, modelCalls };
}

const taskStatus = (id: string): string =>
  (db.prepare('SELECT status FROM coding_tasks WHERE id = ?').get(id) as { status: string }).status;
const taskCount = (): number =>
  (db.prepare('SELECT count(*) n FROM coding_tasks').get() as { n: number }).n;
const sourceCount = (): number =>
  (db.prepare('SELECT count(*) n FROM sources').get() as { n: number }).n;
const jobRows = (): number => (db.prepare('SELECT count(*) n FROM jobs').get() as { n: number }).n;
const auditCount = (kind: string): number =>
  (db.prepare('SELECT count(*) n FROM audit_events WHERE kind = ?').get(kind) as { n: number }).n;
const folderGrantRows = (abs: string): Array<{ id: string }> =>
  db
    .prepare(
      "SELECT id FROM permissions WHERE scope_type='folder' AND status='active' AND lower(locator)=lower(?)",
    )
    .all(abs.replaceAll('\\', '/')) as Array<{ id: string }>;

/** 没绑文件夹的项目 + 一条等你拍板的编码待办（绕过会被拦住的 propose 路径，直接落库）。 */
function seedUnboundDraft(h: ReturnType<typeof setup>, projectId: string) {
  const task = h.coding.create({ projectId, goal: '把 note.txt 写好', scope: ['note.txt'] });
  const title = '把 note.txt 写好';
  const todo = h.todos.propose({ title, linked: { kind: 'coding_task', id: task.id } });
  return { taskId: task.id, todo };
}

describe('P4 验收条件 1：绑定成功——路径、授权、审计、返回', () => {
  it('root_path 是选的文件夹；有效授权覆盖它；审计 project.folder_bound；返回带路径', async () => {
    const h = setup();
    const p = h.projects.create({ name: '未绑定项目', rootPath: null, description: null });
    const f = folder('workspace');
    const before = folderGrantRows(f).length;

    const updated = (await h.runtime.bindProjectFolder(p.id, f)) as { root_path: string | null };

    expect(updated.root_path && resolve(updated.root_path)).toBe(resolve(f));
    expect(folderGrantRows(f).length).toBe(before + 1);
    const audit = db
      .prepare("SELECT detail_json FROM audit_events WHERE kind = 'project.folder_bound'")
      .get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({ projectId: p.id });
    expect(JSON.parse(audit.detail_json).grantId).toBe(folderGrantRows(f)[0]!.id);
  });

  it('文件夹本来就有授权：复用，不重复建', async () => {
    const h = setup();
    const p = h.projects.create({ name: '未绑定项目', rootPath: null, description: null });
    const f = folder('workspace');
    const existing = h.permissions.grantFolder(f);
    await h.runtime.bindProjectFolder(p.id, f);
    expect(folderGrantRows(f)).toHaveLength(1);
    expect(folderGrantRows(f)[0]!.id).toBe(existing.id);
  });
});

describe('P4 验收条件 2：绑定不导入、不调模型', () => {
  it('来源数、提取任务数不变；没有模型调用', async () => {
    const h = setup();
    const p = h.projects.create({ name: '未绑定项目', rootPath: null, description: null });
    const f = folder('workspace');
    const before = { sources: sourceCount(), jobs: jobRows(), calls: h.modelCalls.count };
    await h.runtime.bindProjectFolder(p.id, f);
    expect(sourceCount()).toBe(before.sources);
    expect(jobRows()).toBe(before.jobs);
    expect(h.modelCalls.count).toBe(before.calls);
  });
});

describe('P4 验收条件 3：拒绝——已绑定 / 绑到别的项目 / 项目不存在 / 文件夹不存在', () => {
  it('已经绑了文件夹的项目：报错，项目、授权、审计都不变', async () => {
    const h = setup();
    const f1 = folder('w1');
    const f2 = folder('w2');
    const p = h.projects.create({ name: '已绑定项目', rootPath: f1, description: null });
    const grants = folderGrantRows(f1).length;
    const audits = auditCount('project.folder_bound');
    await expect(h.runtime.bindProjectFolder(p.id, f2)).rejects.toThrow(/已经绑|绑定过/);
    expect(h.projects.get(p.id)!.root_path && resolve(h.projects.get(p.id)!.root_path!)).toBe(
      resolve(f1),
    );
    expect(folderGrantRows(f1).length).toBe(grants);
    expect(folderGrantRows(f2).length).toBe(0);
    expect(auditCount('project.folder_bound')).toBe(audits);
  });

  it('文件夹已经绑在别的项目：报错且提示里有那个项目的名字；大小写/斜杠方向不同也算同一个', async () => {
    const h = setup();
    const f = folder('shared');
    const first = h.projects.create({ name: '第一个项目', rootPath: null, description: null });
    await h.runtime.bindProjectFolder(first.id, f);
    const second = h.projects.create({ name: '第二个项目', rootPath: null, description: null });
    const grants = folderGrantRows(f).length;
    const auditN = auditCount('project.folder_bound');
    const variant = f.replaceAll('\\', '/').toUpperCase() + '/'; // 大小写+尾斜杠变体
    await expect(h.runtime.bindProjectFolder(second.id, variant)).rejects.toThrow(/第一个项目/);
    expect(h.projects.get(second.id)!.root_path).toBeNull();
    expect(folderGrantRows(f).length).toBe(grants);
    expect(auditCount('project.folder_bound')).toBe(auditN);
  });

  it('项目不存在：报错，什么都不改', async () => {
    const h = setup();
    const f = folder('w');
    const audits = auditCount('project.folder_bound');
    await expect(h.runtime.bindProjectFolder('no-such-project', f)).rejects.toThrow(/不存在/);
    expect(folderGrantRows(f).length).toBe(0);
    expect(auditCount('project.folder_bound')).toBe(audits);
  });

  it('文件夹不存在：报错，什么都不改', async () => {
    const h = setup();
    const p = h.projects.create({ name: '未绑定项目', rootPath: null, description: null });
    const ghosts = folderGrantRows(join(dir, 'ghost')).length;
    await expect(h.runtime.bindProjectFolder(p.id, join(dir, 'ghost'))).rejects.toThrow(/不存在/);
    expect(h.projects.get(p.id)!.root_path).toBeNull();
    expect(folderGrantRows(join(dir, 'ghost')).length).toBe(ghosts);
  });
});

describe('P4 验收条件 4：D1 聊天里提编码任务——没绑文件夹拦，绑好放行', () => {
  it('没绑文件夹：同一条文案，不建草案、不记审计；绑好之后再提能建出草案', async () => {
    const h = setup();
    const p = h.projects.create({ name: '未绑定项目', rootPath: null, description: null });
    const f = folder('w');
    const conv = h.conversations.create({ projectId: p.id });
    // 模拟「正在回答」的项目对话（照 D1 的挂起会话）
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.runtime['askSessions'].set(conv.id, {
      run: async () => {
        await gate;
        return {
          answer: 'x',
          citations: [],
          notice: '',
          usedChars: 1,
          modelName: 'hermes',
          engine: 'hermes',
          runId: 'r',
          steps: [],
          memoryUsed: [],
        };
      },
    } as never);

    await expect(
      h.runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow(UNBOUND_MESSAGE);
    expect(taskCount()).toBe(0);
    expect(auditCount('hermes.propose_coding_task')).toBe(0);
    release();

    await h.runtime.bindProjectFolder(p.id, f);
    // 绑好后再提同样的话：能建出草案（再来一轮「正在回答」）
    const conv2 = h.conversations.create({ projectId: p.id });
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    h.runtime['askSessions'].set(conv2.id, {
      run: async () => {
        await gate2;
        return {
          answer: 'x',
          citations: [],
          notice: '',
          usedChars: 1,
          modelName: 'hermes',
          engine: 'hermes',
          runId: 'r2',
          steps: [],
          memoryUsed: [],
        };
      },
    } as never);
    const res = (await h.runtime.hermesTool('propose_coding_task', {
      goal: '加个文件',
      acceptance: ['有文件'],
    })) as { status: string };
    expect(res.status).toBe('draft');
    release2();
  });
});

describe('P4 验收条件 5：待办卡点「要做」——没绑文件夹拦，绑好放行', () => {
  it('没绑文件夹：报同一句话，任务没批准没派发，待办还是等你拍板；绑好再点就开工', async () => {
    const h = setup();
    const p = h.projects.create({ name: '未绑定项目', rootPath: null, description: null });
    const f = folder('w');
    const { taskId, todo } = seedUnboundDraft(h, p.id);
    expect(todo?.status).toBe('proposed');

    await expect(h.runtime.acceptTodo(todo!.id)).rejects.toThrow(UNBOUND_MESSAGE);
    expect(taskStatus(taskId)).toBe('draft');
    expect(h.todos.get(todo!.id).status).toBe('proposed');

    await h.runtime.bindProjectFolder(p.id, f);
    await h.runtime.acceptTodo(todo!.id);
    expect(taskStatus(taskId)).not.toBe('draft');
    expect(h.todos.get(todo!.id).status).toBe('accepted');
  });
});

describe('P4 验收条件 6：任务页「批准」——没绑文件夹拦，绑好照旧', () => {
  it('没绑文件夹：报同一句话，任务没批准；有文件夹的照旧批准', async () => {
    const h = setup();
    const unbound = h.projects.create({ name: '未绑定项目', rootPath: null, description: null });
    const bound = h.projects.create({
      name: '已绑定项目',
      rootPath: folder('bw'),
      description: null,
    });
    const t1 = h.coding.create({ projectId: unbound.id, goal: '写 note.txt', scope: ['note.txt'] });
    const t2 = h.coding.create({ projectId: bound.id, goal: '写 note.txt', scope: ['note.txt'] });

    await expect(h.runtime.approveCodingTask(t1.id)).rejects.toThrow(UNBOUND_MESSAGE);
    expect(taskStatus(t1.id)).toBe('draft');
    await h.runtime.approveCodingTask(t2.id);
    expect(taskStatus(t2.id)).not.toBe('draft');
  });
});
