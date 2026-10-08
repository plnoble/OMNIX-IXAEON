/**
 * D7b 验收（整合方写死，执行方不改）。规格：docs/委派/D7b-按设置选执行器.md
 *
 * 真的编排（CodingOrchestrator）、真的派发（CodingDispatch）、真的网关执行器（D7 的
 * ModelCodingExecutor）、真的 executorPlan / saveCodingSettings；只有模型是假的（FakeProvider），
 * 「Codex」用替身执行器。任务走真实提问链路建出来（带 origin_run_id），点「要做」开工。
 *
 * 钉住的接缝（规格契约 2–7）：
 * - `AppRuntime.saveCodingSettings` / `executorPlan` / `codingModelProvider`；
 * - `apps/desktop/src/main/codingExecutor.ts` 的 `ConfiguredCodingExecutor(codex, plan)`；
 * - 回报的 `meta.status = 'executor_missing'`。
 *
 * 与验收条件的对应写在每个 describe 上。条件 10 的页面部分、条件 11 在 d7b-pages.test.ts。
 * 应用启动时把 ConfiguredCodingExecutor 装进编排这一步，只有端到端测试照得到（规格「端到端测试」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { appConfigSchema, defaultAppConfig } from '@ixaeon/contracts';
import {
  CodingOrchestrator,
  ConversationStore,
  FakeCodingExecutor,
  FakeProvider,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  TodoStore,
  migrate,
  openDatabase,
  type AgentSession,
  type CodingExecutor,
  type CoreDatabase,
} from '@ixaeon/core';
import type { CodingTask } from '@ixaeon/contracts';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { ConfiguredCodingExecutor, type ExecutorPlan } from '../../src/main/codingExecutor.js';
import { registerIpc } from '../../src/main/ipc.js';

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '' },
  BrowserWindow: {},
  dialog: {},
  shell: {},
  ipcMain: { handle: vi.fn() },
  // 测试替身：「加密」= 加前缀，「解密」= 去前缀
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

const GATEWAY = 'https://gateway.example.test/v1';
const KEY = 'sk-synthetic-d7b';
const ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'IXAEON_CODEX_EXE',
  'IXAEON_FAKE_MODEL',
  'IXAEON_OPENAI_BASE_URL',
];

let dir: string;
let db: CoreDatabase;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // 隔开本机的 git 全局配置：提交签名、全局钩子不能影响合成仓库
  process.env['GIT_CONFIG_GLOBAL'] = 'nul';
  process.env['GIT_CONFIG_SYSTEM'] = 'nul';
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-d7b-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (db.open) db.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

type CodingSetting = { executor: string; modelName: string };

interface Harness {
  runtime: AppRuntime;
  /** 「Codex」的替身：被调用时会把 note.txt 改成「替身写的」。 */
  codex: FakeCodingExecutor;
  /** 编码用的假模型。 */
  model: FakeProvider;
  conversations: ConversationStore;
  todos: TodoStore;
  coding: CodingOrchestrator;
  projectId: string;
  root: string;
  configFile: string;
}

const passingCheck = async () => ({ argv: ['node'], exitCode: 0, output: 'ok', ran: true });

function setup(
  opts: {
    coding?: CodingSetting;
    savedModels?: string[];
    key?: boolean;
    /** 用真的 codingModelProvider（默认换成直接给假模型）。 */
    realProvider?: boolean;
    /** 「Codex」替身自己说没做成，并带一句说明。 */
    codexDeclines?: string;
  } = {},
): Harness {
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), '# 合成项目\n');
  writeFileSync(join(root, 'note.txt'), '第一版\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', '初始'],
    { cwd: root },
  );
  const projects = new ProjectService(db);
  const project = projects.create({ name: '合成项目', rootPath: root, description: null });
  // P6（2026-10-08）：运行时也挂上授权服务（批准、派发之前那道检查要问它）
  const permissions = new PermissionService(db);
  permissions.grantFolder(root);
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const codex = new FakeCodingExecutor({
    claimedSuccess: opts.codexDeclines === undefined,
    files: { 'note.txt': '替身写的\n' },
    ...(opts.codexDeclines !== undefined ? { summary: opts.codexDeclines } : {}),
  });
  const model = new FakeProvider('d7b-coding');
  const askProvider = new FakeProvider('d7b-ask');
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  const coding = new CodingOrchestrator(
    db,
    new ConfiguredCodingExecutor(codex, () => runtime.executorPlan()),
    join(dir, 'data'),
    passingCheck as never,
  );
  const withKey = opts.key !== false;
  const base = defaultAppConfig();
  const configFile = join(dir, 'config.json');
  Object.assign(runtime, {
    db,
    conversations,
    todos,
    coding,
    projects,
    permissions,
    items: new ItemService(db),
    search: new SearchService(db),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => askProvider,
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
    configFile,
    config: {
      ...base,
      setupComplete: true,
      model: {
        ...base.model,
        modelName: 'analysis-model',
        apiBaseUrl: GATEWAY,
        apiKeyPresent: withKey,
        apiKeyEncrypted: withKey ? Buffer.from(`enc:${KEY}`).toString('base64') : null,
        savedModels: opts.savedModels ?? ['m1', 'm2'],
      },
      ...(opts.coding ? { coding: opts.coding } : {}),
    },
    ...(opts.realProvider ? {} : { codingModelProvider: () => model }),
  });
  return {
    runtime,
    codex,
    model,
    conversations,
    todos,
    coding,
    projectId: project.id,
    root,
    configFile,
  };
}

/** 走真实提问链路建一个带 origin_run_id 的编码任务草案，并挂成待办。 */
async function proposedTask(
  h: Harness,
  input: { goal: string; scope: string[] },
): Promise<{ todoId: string; taskId: string; conversationId: string }> {
  const conv = h.conversations.create({ projectId: h.projectId });
  let taskId = '';
  h.runtime['askSessions'].set(conv.id, {
    run: async () => {
      const task = h.coding.create({
        projectId: h.projectId,
        goal: input.goal,
        scope: input.scope,
        allowedCommands: [[process.execPath, '-e', 'process.exit(0)']],
      });
      taskId = task.id;
      return {
        answer: '可以，我起草了一个编码任务，等你拍板。',
        citations: [],
        notice: '',
        usedChars: 1,
        modelName: 'hermes',
        engine: 'hermes',
        runId: 'fake',
        steps: [],
        memoryUsed: [],
      };
    },
    cancel: () => undefined,
    getEngineSessionId: () => 's-d7b',
  } as unknown as AgentSession);
  const r = await h.runtime.ask({
    conversationId: conv.id,
    projectId: h.projectId,
    question: '把这个做了',
  });
  const [todo] = h.todos.list({ status: ['proposed'] }).filter((t) => t.linked_id === taskId);
  return { todoId: todo!.id, taskId, conversationId: r.conversationId };
}

interface TaskRow {
  status: string;
  executor_name: string | null;
  workspace_path: string | null;
  error: string | null;
  applied_ref: string | null;
}
const taskRow = (id: string) =>
  db
    .prepare(
      'SELECT status, executor_name, workspace_path, error, applied_ref FROM coding_tasks WHERE id = ?',
    )
    .get(id) as TaskRow;

function reports(conversationId: string) {
  return (
    db
      .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as Array<{ content: string; meta_json: string }>
  )
    .map((r) => ({ content: r.content, meta: JSON.parse(r.meta_json) as Record<string, unknown> }))
    .filter((m) => m.meta['kind'] === 'task_report');
}

const settled = (id: string) =>
  vi.waitFor(() => expect(['pending_accept', 'failed']).toContain(taskRow(id).status), {
    timeout: 20_000,
  });

const readmeChange = (line: string) => ({
  changes: [{ path: 'README.md', action: 'write', content: `# 合成项目\n${line}\n` }],
  summary: '加了一行',
  claimedSuccess: true,
});

const MODEL_M1: CodingSetting = { executor: 'model', modelName: 'm1' };

describe('条件 2、3：配置与保存', () => {
  it('旧配置没有 coding 这段：照常读出来，默认交给 Codex；不认的执行器不收', () => {
    const legacy = { ...defaultAppConfig() } as Record<string, unknown>;
    delete legacy['coding'];
    expect(appConfigSchema.parse(legacy).coding).toEqual({ executor: 'codex', modelName: '' });
    expect(defaultAppConfig().coding).toEqual({ executor: 'codex', modelName: '' });
    expect(() =>
      appConfigSchema.parse({ ...legacy, coding: { executor: 'banana', modelName: '' } }),
    ).toThrow();
  });

  it('保存：只动 coding，落盘，重读还在；也能经 IPC 保存', async () => {
    const h = setup();
    const modelBefore = structuredClone(h.runtime.getConfig().model);
    expect(h.runtime.saveCodingSettings({ executor: 'model', modelName: 'm2' })).toEqual({
      ok: true,
    });
    const onDisk = appConfigSchema.parse(JSON.parse(readFileSync(h.configFile, 'utf8')));
    expect(onDisk.coding).toEqual({ executor: 'model', modelName: 'm2' });
    expect(onDisk.model).toEqual(modelBefore);
    // 选了「我的模型」但还没选模型：也能存（派发时会拦，见条件 6）
    h.runtime.saveCodingSettings({ executor: 'model', modelName: '' });
    expect(h.runtime.getConfig().coding).toEqual({ executor: 'model', modelName: '' });
    // IPC 同名
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([ch]) => ch === 'ixaeon:saveCodingSettings');
    expect(entry, '没有注册 IPC：saveCodingSettings').toBeTruthy();
    await entry![1]({} as never, { executor: 'codex', modelName: 'm1' });
    expect(h.runtime.getConfig().coding).toEqual({ executor: 'codex', modelName: 'm1' });
  });

  it('模型名不在已保存清单里、执行器不认：拒绝，配置不变', () => {
    const h = setup({ coding: MODEL_M1 });
    expect(() => h.runtime.saveCodingSettings({ executor: 'model', modelName: 'gone' })).toThrow();
    expect(() =>
      h.runtime.saveCodingSettings({ executor: 'banana' as 'model', modelName: 'm1' }),
    ).toThrow();
    expect(h.runtime.getConfig().coding).toEqual(MODEL_M1);
    expect(existsSync(h.configFile)).toBe(false);
  });
});

describe('条件 1：默认交给 Codex——与现在一模一样', () => {
  for (const [label, coding] of [
    ['没有 coding 这段', undefined],
    ['选的是 Codex（哪怕模型名留着）', { executor: 'codex', modelName: 'm1' }],
  ] as Array<[string, CodingSetting | undefined]>) {
    it(`${label}：用原来的执行器，模型一次没被调用，回报里没有「我的模型」`, async () => {
      const h = setup(coding ? { coding } : {});
      expect(h.runtime.executorPlan()).toEqual({ use: 'codex' });
      const t = await proposedTask(h, { goal: '把说明写清楚', scope: ['note.txt'] });
      await h.runtime.acceptTodo(t.todoId);
      await settled(t.taskId);
      const row = taskRow(t.taskId);
      expect(row.status).toBe('pending_accept');
      expect(row.executor_name).toBe('fake');
      expect(readFileSync(join(row.workspace_path!, 'note.txt'), 'utf8')).toBe('替身写的\n');
      expect(h.model.structuredCalls).toHaveLength(0);
      const [report] = reports(t.conversationId);
      expect(report!.content).toContain('把说明写清楚');
      expect(report!.content).not.toContain('我的模型');
    });
  }

  it('选的是 Codex 而本机没装：照旧不派发、回报「没找到 Codex」', async () => {
    const h = setup({ coding: { executor: 'codex', modelName: 'm1' } });
    h.runtime.codexLocator = () => null;
    const t = await proposedTask(h, { goal: '把说明写清楚', scope: ['note.txt'] });
    await h.runtime.acceptTodo(t.todoId);
    await vi.waitFor(() => expect(reports(t.conversationId)).toHaveLength(1));
    expect(reports(t.conversationId)[0]!.meta['status']).toBe('codex_missing');
    expect(reports(t.conversationId)[0]!.content).toContain('没找到 Codex');
    expect(taskRow(t.taskId).status).toBe('queued');
    expect(h.codex.lastGoal).toBe('');
  });
});

describe('条件 4：选了「我的模型」——点「要做」到建出分支', () => {
  it('网关执行器做完 → 验证 → 回报 → 接受 → 分支上正好是这些改动；没装 Codex 也照常', async () => {
    const h = setup({ coding: MODEL_M1 });
    h.runtime.codexLocator = () => null; // 本机没装 Codex
    h.model.enqueueStructured(readmeChange('模型加的一行'));
    const t = await proposedTask(h, { goal: '在 README.md 末尾加一行', scope: ['README.md'] });
    await h.runtime.acceptTodo(t.todoId);
    await settled(t.taskId);

    const row = taskRow(t.taskId);
    expect(row.error).toBeNull();
    expect(row.status).toBe('pending_accept');
    expect(row.executor_name).toBe('model:m1');
    expect(h.codex.lastGoal, '「Codex」不该被调用').toBe('');
    // 发给模型的：目标、批准范围里的文件内容
    expect(h.model.structuredCalls).toHaveLength(1);
    const sent = `${h.model.structuredCalls[0]!.system}\n${h.model.structuredCalls[0]!.user}`;
    expect(sent).toContain('在 README.md 末尾加一行');
    expect(sent).toContain('# 合成项目');
    // 写进的是副本，真实项目没动
    expect(readFileSync(join(row.workspace_path!, 'README.md'), 'utf8')).toContain('模型加的一行');
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('# 合成项目\n');

    const [report] = reports(t.conversationId);
    expect(report!.meta['status']).toBe('pending_accept');
    expect(report!.content).toContain('我的模型（m1）');
    expect(report!.content).toContain('验证通过');
    expect(report!.content).toContain('README.md');

    await h.runtime.acceptCodingTask(t.taskId);
    const branch = `ixaeon/${t.taskId.slice(0, 8)}`;
    expect(taskRow(t.taskId).applied_ref).toBe(branch);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: h.root, encoding: 'utf8' }).trim();
    expect(git('diff', '--name-only', 'main', branch)).toBe('README.md');
    expect(git('show', `${branch}:README.md`)).toContain('模型加的一行');
    // 用户的工作区没动
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('# 合成项目\n');
  });
});

describe('条件 5：模型要改范围外的文件', () => {
  it('任务失败，回报里有那个路径和「我的模型」；真实项目和副本都没多出文件', async () => {
    const h = setup({ coding: MODEL_M1 });
    h.model.enqueueStructured({
      changes: [{ path: 'other.txt', action: 'write', content: '范围外' }],
      summary: '新建了 other.txt',
      claimedSuccess: true,
    });
    const t = await proposedTask(h, { goal: '新建一个 other.txt', scope: ['README.md'] });
    await h.runtime.acceptTodo(t.todoId);
    await settled(t.taskId);
    const row = taskRow(t.taskId);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('other.txt');
    const [report] = reports(t.conversationId);
    expect(report!.meta['status']).toBe('failed');
    expect(report!.content).toContain('other.txt');
    expect(report!.content).toContain('我的模型（m1）');
    expect(existsSync(join(h.root, 'other.txt'))).toBe(false);
    expect(existsSync(join(row.workspace_path!, 'other.txt'))).toBe(false);
  });
});

describe('条件 12（整合方复审实现时补）：模型自己说做不到——回报里有它说的原因', () => {
  it('任务失败，什么都没写；回报里有模型的说明和「我的模型」', async () => {
    const h = setup({ coding: MODEL_M1 });
    h.model.enqueueStructured({
      changes: [],
      summary: '范围里只有 README.md，新建不了 other.txt',
      claimedSuccess: false,
    });
    const t = await proposedTask(h, { goal: '新建一个 other.txt', scope: ['README.md'] });
    await h.runtime.acceptTodo(t.todoId);
    await settled(t.taskId);
    const row = taskRow(t.taskId);
    expect(row.status).toBe('failed');
    expect(existsSync(join(row.workspace_path!, 'other.txt'))).toBe(false);
    const [report] = reports(t.conversationId);
    expect(report!.meta['status']).toBe('failed');
    expect(report!.content).toContain('范围里只有 README.md，新建不了 other.txt');
    expect(report!.content).toContain('我的模型（m1）');
  });

  it('别的执行器说没做成：回报和现在一样，不多出它的说明', async () => {
    const h = setup({ codexDeclines: 'STANDIN_SUMMARY' });
    const t = await proposedTask(h, { goal: '把说明写清楚', scope: ['note.txt'] });
    await h.runtime.acceptTodo(t.todoId);
    await settled(t.taskId);
    expect(taskRow(t.taskId).status).toBe('failed');
    const [report] = reports(t.conversationId);
    expect(report!.content).toContain('执行器未声称成功');
    expect(report!.content).not.toContain('STANDIN_SUMMARY');
    expect(report!.content).not.toContain('我的模型');
  });
});

describe('条件 6：选了「我的模型」但还不能用——不派发，告诉用户缺什么', () => {
  const cases: Array<[string, Parameters<typeof setup>[0], 'model_name' | 'model_key', RegExp]> = [
    ['没选模型', { coding: { executor: 'model', modelName: '' } }, 'model_name', /模型/],
    [
      '选的模型已不在已保存清单里',
      { coding: { executor: 'model', modelName: 'gone' } },
      'model_name',
      /模型/,
    ],
    ['没配 Key', { coding: MODEL_M1, key: false, realProvider: true }, 'model_key', /Key/],
  ];
  for (const [label, opts, missing, word] of cases) {
    it(`${label}：留在排队，对话里回报一条、不重复；任务页点派发也不派发；什么都没发给模型`, async () => {
      const fetchCalls: unknown[] = [];
      vi.stubGlobal('fetch', (...args: unknown[]) => {
        fetchCalls.push(args[0]);
        throw new Error('这时候不该有任何网络请求');
      });
      const h = setup(opts);
      expect(h.runtime.executorPlan()).toEqual({ use: 'none', missing });
      const t = await proposedTask(h, {
        goal: '在 README.md 末尾加一行\n细节',
        scope: ['README.md'],
      });
      await h.runtime.acceptTodo(t.todoId);
      await vi.waitFor(() => expect(reports(t.conversationId)).toHaveLength(1));
      const [report] = reports(t.conversationId);
      expect(report!.meta).toMatchObject({ taskId: t.taskId, status: 'executor_missing' });
      expect(report!.content).toContain('在 README.md 末尾加一行');
      expect(report!.content).toContain('设置');
      expect(report!.content).toMatch(word);
      expect(taskRow(t.taskId).status).toBe('queued');
      // 再催一次：回报还是一条
      h.runtime['codingDispatch'].kick(t.taskId);
      await new Promise((r) => setTimeout(r, 50));
      expect(reports(t.conversationId)).toHaveLength(1);
      // 任务页点「派发」：同样不派发，报错里说去设置
      await expect(h.runtime.finishCodingTask(t.taskId, 'dispatch')).rejects.toThrow(/设置/);
      expect(taskRow(t.taskId).status).toBe('queued');
      expect(h.model.structuredCalls).toHaveLength(0);
      expect(h.codex.lastGoal).toBe('');
      expect(fetchCalls).toEqual([]);
    });
  }

  it('补好设置之后在任务页点派发：接着做完', async () => {
    const h = setup({ coding: { executor: 'model', modelName: '' } });
    const t = await proposedTask(h, { goal: '在 README.md 末尾加一行', scope: ['README.md'] });
    await h.runtime.acceptTodo(t.todoId);
    await vi.waitFor(() => expect(reports(t.conversationId)).toHaveLength(1));
    expect(taskRow(t.taskId).status).toBe('queued');

    h.runtime.saveCodingSettings(MODEL_M1);
    h.model.enqueueStructured(readmeChange('补好设置后加的一行'));
    const done = await h.runtime.finishCodingTask(t.taskId, 'dispatch');
    expect(done.status).toBe('pending_accept');
    expect(taskRow(t.taskId).executor_name).toBe('model:m1');
    const all = reports(t.conversationId);
    expect(all.map((r) => r.meta['status'])).toEqual(['executor_missing', 'pending_accept']);
  });
});

describe('条件 7、8：按派发那一刻的设置走', () => {
  it('改了设置不用重启：同一个运行时里先后两个任务，各用各的执行器', async () => {
    const h = setup({ coding: MODEL_M1 });
    h.model.enqueueStructured(readmeChange('第一个任务加的'));
    const first = await proposedTask(h, { goal: '第一个任务', scope: ['README.md'] });
    await h.runtime.acceptTodo(first.todoId);
    await settled(first.taskId);
    expect(taskRow(first.taskId).executor_name).toBe('model:m1');
    expect(h.codex.lastGoal).toBe('');

    h.runtime.saveCodingSettings({ executor: 'codex', modelName: 'm1' });
    const second = await proposedTask(h, { goal: '第二个任务', scope: ['note.txt'] });
    await h.runtime.acceptTodo(second.todoId);
    await settled(second.taskId);
    expect(taskRow(second.taskId).executor_name).toBe('fake');
    expect(h.codex.lastGoal).toContain('第二个任务');
    expect(h.model.structuredCalls).toHaveLength(1);
  });

  it('跑到一半改了设置：这个任务记的还是开工时的执行器，另一个没被调用', async () => {
    const h = setup({ coding: MODEL_M1 });
    h.model.chatDelayMs = 300;
    h.model.enqueueStructured(readmeChange('慢慢加的一行'));
    const t = await proposedTask(h, { goal: '慢任务', scope: ['README.md'] });
    await h.runtime.acceptTodo(t.todoId);
    await vi.waitFor(() => expect(taskRow(t.taskId).status).toBe('running'));
    expect(taskRow(t.taskId).executor_name).toBe('model:m1');
    h.runtime.saveCodingSettings({ executor: 'codex', modelName: 'm1' });
    await settled(t.taskId);
    const row = taskRow(t.taskId);
    expect(row.status).toBe('pending_accept');
    expect(row.executor_name).toBe('model:m1');
    expect(h.codex.lastGoal).toBe('');
    expect(reports(t.conversationId)[0]!.content).toContain('我的模型（m1）');
  });
});

describe('契约 5：ConfiguredCodingExecutor', () => {
  it('run 在被调用的那一刻取 plan（之后再改不影响这次）；name 按当前 plan；none 时拒绝', async () => {
    const calls: string[] = [];
    const stub = (name: string): CodingExecutor => ({
      name,
      run: async () => {
        calls.push(name);
        return {
          claimedSuccess: true,
          summary: name,
          changedPaths: [],
          testsModified: false,
          raw: '',
        };
      },
    });
    const codex = stub('codex-cli');
    const mine = stub('model:m9');
    let plan: ExecutorPlan = { use: 'model', executor: mine };
    const exe = new ConfiguredCodingExecutor(codex, () => plan);
    const run = () => exe.run({} as CodingTask, dir, new AbortController().signal);

    expect(exe.name).toBe('model:m9');
    const running = run();
    plan = { use: 'codex' }; // 调用之后马上改了设置
    expect((await running).summary).toBe('model:m9');
    expect(calls).toEqual(['model:m9']);

    expect(exe.name).toBe('codex-cli');
    expect((await run()).summary).toBe('codex-cli');
    expect(calls).toEqual(['model:m9', 'codex-cli']);

    plan = { use: 'none', missing: 'model_name' };
    expect(exe.name).toBe('codex-cli');
    await expect(run()).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});

describe('条件 9：编码用的模型客户端', () => {
  it('存了 Key：请求发到已保存的地址、带已保存的 Key、用的是传入的模型名', async () => {
    const h = setup({ coding: MODEL_M1, realProvider: true });
    const calls: Array<{ url: string; auth: string | null; model: unknown }> = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
        model: (JSON.parse(String(init?.body ?? '{}')) as { model?: unknown }).model,
      });
      return new Response('{"error":"synthetic"}', { status: 400 });
    });
    const provider = h.runtime.codingModelProvider('m2');
    expect(provider).not.toBeNull();
    expect(provider!.modelName).toBe('m2');
    await provider!.chatText({ system: 's', user: 'u' }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.startsWith(`${GATEWAY}/`)).toBe(true);
      expect(c.auth).toBe(`Bearer ${KEY}`);
      expect(c.model).toBe('m2');
    }
    // executorPlan 用的就是它
    const plan = h.runtime.executorPlan();
    expect(plan.use).toBe('model');
    expect(plan.use === 'model' && plan.executor.name).toBe('model:m1');
  });

  it('没存 Key：拿不到', () => {
    const h = setup({ coding: MODEL_M1, key: false, realProvider: true });
    expect(h.runtime.codingModelProvider('m1')).toBeNull();
  });

  it('假模型模式（IXAEON_FAKE_MODEL=1）：给的就是假模型，不建联网的客户端', async () => {
    process.env['IXAEON_FAKE_MODEL'] = '1';
    const fetchCalls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      fetchCalls.push(args[0]);
      throw new Error('假模型模式不该联网');
    });
    const h = setup({ coding: MODEL_M1, realProvider: true });
    const provider = h.runtime.codingModelProvider('m1');
    expect(provider).toBe(h.runtime.getProvider());
    await provider!.chatText({ system: 's', user: 'u' }).catch(() => undefined);
    expect(fetchCalls).toEqual([]);
  });
});

describe('条件 10：任务页顶部的说明（listCodingTasks）', () => {
  async function listCodingTasks(h: Harness) {
    vi.mocked(ipcMain.handle).mockClear();
    registerIpc(h.runtime);
    const entry = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([ch]) => ch === 'ixaeon:listCodingTasks');
    return (await entry![1]({} as never)) as { executor: string; notice: string };
  }

  it('选了「我的模型」：写明交给谁、文件内容会发给它', async () => {
    const snap = await listCodingTasks(setup({ coding: MODEL_M1 }));
    expect(snap.executor).toBe('model');
    expect(snap.notice).toContain('我的模型（m1）');
    expect(snap.notice).toMatch(/发给/);
    expect(snap.notice).not.toMatch(/Fake|Codex CLI/);
  });

  it('选了「我的模型」但缺东西：写缺什么、去设置补', async () => {
    const snap = await listCodingTasks(setup({ coding: { executor: 'model', modelName: '' } }));
    expect(snap.executor).toBe('model');
    expect(snap.notice).toContain('设置');
    expect(snap.notice).toMatch(/模型/);
    expect(snap.notice).not.toMatch(/Fake|Codex CLI/);
  });

  it('默认：说明与现在一样', async () => {
    const snap = await listCodingTasks(setup());
    expect(snap.executor).toBe('fake');
    expect(snap.notice).toContain('未找到 Codex CLI');
  });
});
