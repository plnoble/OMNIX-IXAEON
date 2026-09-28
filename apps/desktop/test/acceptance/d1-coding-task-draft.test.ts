/**
 * D1 验收（规格 docs/委派/D1-聊天里提编码任务.md 条件 1–6）
 *
 * 条件 1：项目对话正在回答时，桥接调用 propose_coding_task → 建出草案：
 *   项目是这个对话的项目，origin_run_id 是这一轮，acceptance_json 是给的条件；
 *   这一轮回答下面出现它的待办卡。
 * 条件 2：没有正在回答的提问、或正在回答的是不属于项目的对话：报错，不建任务。
 * 条件 3：两个项目对话同时在回答：报错，不建任务。
 * 条件 4：参数校验：目标为空、条件 0 条或多于 8 条、单条超过 200 字、
 *   scope 越出项目 → VALIDATION_FAILED，不建任务。
 * 条件 5：参数里写了别的项目：不认，照条件 3 的规则取项目。
 * 条件 6：记忆桥名单与 MCP 服务声明里都有这个工具；本地 /api/hermes/tool 照名单放行。
 *   （约定文字部分见 packages/core/test/acceptance/d1-convention.test.ts。）
 *
 * 桥接调用不在提问的异步上下文里（真 Hermes 经 MCP 服务转 HTTP 进来），
 * 所以测试里替身会话挂起模拟「正在回答」，桥接调用从提问的异步链之外发起。
 *
 * 整合方复审时定（2026-09-28）：
 * - 条件 3 扩成「正在回答的不止一个（不论是不是项目对话）→ 报错『同时有多个对话在回答，
 *   分不清是哪个，请稍后再提』」。所有对话的 Hermes 共用一个桥令牌，分不出是谁调的工具；
 *   一个项目对话加一个个人对话同时在回答时，若默认算给项目对话，个人对话里的一句话就会
 *   在项目里建出任务。
 * - 补一条：没写 scope 的草案（缺省整个项目，存成 ['.']）点「要做」派发后，改项目里的文件
 *   （含子目录）不算越界、能走到等你验收。执行器的范围检查只认「等于或在其下」，'.' 不被当成
 *   整个项目的话，每个没写范围的任务都会以「改动超出批准范围」失败，场景一在这里就断了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
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
  Vault,
  migrate,
  openDatabase,
  type AgentSession,
  type CoreDatabase,
} from '@ixaeon/core';
import {
  defaultAppConfig,
  ErrorCodes,
  HERMES_BRIDGE_TOOLS,
  type AppConfig,
} from '@ixaeon/contracts';
import { registerHermesBridgeTools } from '../../../mcp/src/shared.js';
import { AppRuntime } from '../../src/main/appRuntime.js';
import { LocalServer } from '../../src/main/server/localServer.js';

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  safeStorage: {},
}));

const BRIDGE_TOKEN = 'd1-bridge-token-'.padEnd(64, '2');

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-d1-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(
  opts: { executor?: FakeCodingExecutor; runCheck?: CodingOrchestrator['runCheck'] } = {},
) {
  const root = join(dir, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'note.txt'), '合成文件');
  const projects = new ProjectService(db);
  const project = projects.create({ name: '合成项目', rootPath: root, description: null });
  const conversations = new ConversationStore(db);
  const todos = new TodoStore(db);
  const coding = new CodingOrchestrator(
    db,
    opts.executor ?? new FakeCodingExecutor(),
    join(dir, 'data'),
    opts.runCheck as never,
  );
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations,
    todos,
    coding,
    items: new ItemService(db),
    search: new SearchService(db),
    projects,
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => new FakeProvider('d1'),
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  return { runtime, conversations, todos, projects, project };
}

/** 开一轮「正在回答」的提问：替身会话挂起，等 release 才收尾。 */
function startAsk(
  runtime: AppRuntime,
  conversationId: string,
  projectId: string | null,
  question = '把 hello.txt 加了',
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime['askSessions'].set(conversationId, {
    run: async (input: { runId?: string }) => {
      await gate;
      return {
        answer: '好，我提了一个编码任务草案，等你点「要做」。',
        citations: [],
        notice: '',
        usedChars: 1,
        modelName: 'hermes',
        engine: 'hermes',
        runId: input.runId ?? 'fake',
        steps: [],
        memoryUsed: [],
      };
    },
    cancel: () => undefined,
    getEngineSessionId: () => 's-d1',
  } as unknown as AgentSession);
  const askPromise = runtime.ask({ conversationId, projectId, question });
  return {
    askPromise,
    release: () => release(),
  };
}

async function waitActive(runtime: AppRuntime, n: number): Promise<void> {
  const map = runtime['activeAskRuns'] as Map<string, string>;
  for (let i = 0; i < 300 && map.size < n; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(map.size).toBe(n);
}

const taskCount = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get() as { n: number }).n;

describe('聊天里提编码任务草案', () => {
  it('条件 1：项目对话正在回答时提草案 → 建出任务挂在这一轮回答下', async () => {
    const { runtime, conversations, todos, project } = setup();
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    // 桥接调用：从提问的异步上下文之外发起（真 Hermes 经 MCP 服务转 HTTP 进来）
    const res = (await runtime.hermesTool('propose_coding_task', {
      goal: '加一个 hello.txt，写上你好',
      acceptance: ['项目里有 hello.txt，内容是你好', '不用改别的文件'],
    })) as { taskId: string; status: string; project: string; note: string };
    expect(res.status).toBe('draft');
    expect(res.project).toBe('合成项目');
    // 契约 5：note 文案规格写死，逐字核对
    expect(res.note).toBe('草案已建：用户在这条回答下面点「要做」才会开工；不要说已经做完');
    const row = db
      .prepare(
        'SELECT project_id, goal, origin_run_id, acceptance_json, status, scope_json, allowed_commands_json FROM coding_tasks WHERE id = ?',
      )
      .get(res.taskId) as {
      project_id: string;
      goal: string;
      origin_run_id: string | null;
      acceptance_json: string | null;
      status: string;
      scope_json: string;
      allowed_commands_json: string;
    };
    expect(row.project_id).toBe(project.id);
    expect(row.goal).toBe('加一个 hello.txt，写上你好');
    expect(row.status).toBe('draft');
    expect(JSON.parse(row.acceptance_json ?? 'null')).toEqual([
      '项目里有 hello.txt，内容是你好',
      '不用改别的文件',
    ]);
    // scope 缺省为整个项目；验证命令先留空（独立验收由 D2 做）
    expect(JSON.parse(row.scope_json)).toEqual(['.']);
    expect(JSON.parse(row.allowed_commands_json)).toEqual([]);
    ask.release();
    const r = await ask.askPromise;
    expect(row.origin_run_id).toBe(r.runId);
    // 这一轮回答下面出现它的待办卡
    const [t] = todos.list({ status: ['proposed'] });
    expect(t).toMatchObject({
      linked_kind: 'coding_task',
      linked_id: res.taskId,
      conversation_id: conv.id,
      message_id: r.messageId,
    });
    // 记审计 hermes.propose_coding_task（任务 id、项目 id）
    const audit = db
      .prepare("SELECT detail_json FROM audit_events WHERE kind = 'hermes.propose_coding_task'")
      .get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      taskId: res.taskId,
      projectId: project.id,
    });
  });

  it('条件 1/契约 2：显式 scope 存项目内相对路径', async () => {
    const { runtime, conversations, project } = setup();
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    const res = (await runtime.hermesTool('propose_coding_task', {
      goal: '整理文档',
      acceptance: ['docs 目录下有 README'],
      scope: 'docs',
    })) as { taskId: string };
    ask.release();
    await ask.askPromise;
    const row = db.prepare('SELECT scope_json FROM coding_tasks WHERE id = ?').get(res.taskId) as {
      scope_json: string;
    };
    expect(JSON.parse(row.scope_json)).toEqual(['docs']);
  });

  it('条件 2：没有正在回答的提问 → 报错，不建任务', async () => {
    const { runtime } = setup();
    await expect(
      runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow('编码任务只能在项目对话里提（先选项目、开新对话）');
    expect(taskCount()).toBe(0);
  });

  it('条件 2/契约 3：没有正在回答时，参数里带了合法项目也不认', async () => {
    // 契约 3「参数里带的项目一律不认」：不能拿参数里的项目兜底
    const { runtime, conversations, projects } = setup();
    const other = projects.create({
      name: '合成项目二',
      rootPath: join(dir, 'project2'),
      description: null,
    });
    void conversations;
    await expect(
      runtime.hermesTool('propose_coding_task', {
        goal: '加个文件',
        acceptance: ['有文件'],
        projectId: other.id,
      }),
    ).rejects.toThrow('编码任务只能在项目对话里提（先选项目、开新对话）');
    expect(taskCount()).toBe(0);
  });

  it('条件 2/契约 3：只有个人对话在回答时，参数里带了合法项目也不认', async () => {
    const { runtime, conversations, projects } = setup();
    const other = projects.create({
      name: '合成项目二',
      rootPath: join(dir, 'project2'),
      description: null,
    });
    const conv = conversations.create({ projectId: null });
    const ask = startAsk(runtime, conv.id, null, '随便聊聊');
    await waitActive(runtime, 1);
    await expect(
      runtime.hermesTool('propose_coding_task', {
        goal: '加个文件',
        acceptance: ['有文件'],
        projectId: other.id,
      }),
    ).rejects.toThrow('编码任务只能在项目对话里提（先选项目、开新对话）');
    expect(taskCount()).toBe(0);
    ask.release();
    await ask.askPromise;
  });

  it('条件 2：正在回答的对话不属于项目 → 报错，不建任务', async () => {
    const { runtime, conversations } = setup();
    const conv = conversations.create({ projectId: null });
    const ask = startAsk(runtime, conv.id, null, '随便聊聊');
    await waitActive(runtime, 1);
    await expect(
      runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow('编码任务只能在项目对话里提（先选项目、开新对话）');
    expect(taskCount()).toBe(0);
    ask.release();
    await ask.askPromise;
  });

  it('条件 3：两个项目对话同时在回答 → 报错，不建任务', async () => {
    const { runtime, conversations, project } = setup();
    const convA = conversations.create({ projectId: project.id });
    const convB = conversations.create({ projectId: project.id });
    const askA = startAsk(runtime, convA.id, project.id);
    const askB = startAsk(runtime, convB.id, project.id);
    await waitActive(runtime, 2);
    await expect(
      runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow('同时有多个对话在回答，分不清是哪个，请稍后再提');
    expect(taskCount()).toBe(0);
    askA.release();
    askB.release();
    await askA.askPromise;
    await askB.askPromise;
  });

  it('条件 3（整合方定）：项目对话和个人对话同时在回答 → 报「多个对话在回答」，不建草案', async () => {
    // 分不出是哪个对话调的工具：不能默认算给项目对话（可能是个人对话里的请求）。
    const { runtime, conversations, project } = setup();
    const projectConv = conversations.create({ projectId: project.id });
    const personalConv = conversations.create({ projectId: null });
    const projectAsk = startAsk(runtime, projectConv.id, project.id);
    const personalAsk = startAsk(runtime, personalConv.id, null, '随便聊聊');
    await waitActive(runtime, 2);
    await expect(
      runtime.hermesTool('propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }),
    ).rejects.toThrow('同时有多个对话在回答，分不清是哪个，请稍后再提');
    expect(taskCount()).toBe(0);
    projectAsk.release();
    personalAsk.release();
    await projectAsk.askPromise;
    await personalAsk.askPromise;
  });

  it('条件 4：参数不合法 → VALIDATION_FAILED，不建任务', async () => {
    const { runtime, conversations, project } = setup();
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    // 先确认合法参数能建出草案：排除「工具没接上、任何调用都报 VALIDATION_FAILED」的假绿
    const ok = (await runtime.hermesTool('propose_coding_task', {
      goal: '加个文件',
      acceptance: ['有文件'],
    })) as { status: string };
    expect(ok.status).toBe('draft');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['缺 goal', { acceptance: ['有文件'] }],
      ['缺 acceptance', { goal: '加个文件' }],
      ['goal 不是字符串', { goal: 42, acceptance: ['有文件'] }],
      ['acceptance 不是数组', { goal: '加个文件', acceptance: '有文件' }],
      ['目标为空', { goal: '', acceptance: ['有文件'] }],
      ['目标是空白', { goal: '   ', acceptance: ['有文件'] }],
      ['目标超 2000 字', { goal: '字'.repeat(2001), acceptance: ['有文件'] }],
      ['条件 0 条', { goal: '加个文件', acceptance: [] }],
      ['条件多于 8 条', { goal: '加个文件', acceptance: Array.from({ length: 9 }, () => '条件') }],
      ['单条条件超 200 字', { goal: '加个文件', acceptance: ['字'.repeat(201)] }],
      ['单条条件为空字符串', { goal: '加个文件', acceptance: [''] }],
      ['单条条件为空白字符串', { goal: '加个文件', acceptance: ['   '] }],
      ['scope 越出项目（..）', { goal: '加个文件', acceptance: ['有文件'], scope: '../outside' }],
      ['scope 越出项目（裸 ..）', { goal: '加个文件', acceptance: ['有文件'], scope: '..' }],
      [
        'scope 越出项目（Windows 反斜杠）',
        { goal: '加个文件', acceptance: ['有文件'], scope: '..\\outside' },
      ],
      ['scope 越出项目（根路径）', { goal: '加个文件', acceptance: ['有文件'], scope: '/outside' }],
      [
        'scope 越出项目（嵌套越界）',
        { goal: '加个文件', acceptance: ['有文件'], scope: 'a/b/../../..' },
      ],
      [
        'scope 越出项目（绝对路径）',
        { goal: '加个文件', acceptance: ['有文件'], scope: 'C:\\tmp' },
      ],
    ];
    for (const [name, args] of cases) {
      await expect(runtime.hermesTool('propose_coding_task', args), name).rejects.toMatchObject({
        code: ErrorCodes.VALIDATION_FAILED,
      });
    }
    // 只有开头那次合法调用建了任务，非法参数一次都没建
    expect(taskCount()).toBe(1);
    ask.release();
    await ask.askPromise;
  });

  it('条件 4 对照：合法上限都能建出草案（目标 2000 字、8 条条件、单条 200 字）', async () => {
    const { runtime, conversations, project } = setup();
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    const res = (await runtime.hermesTool('propose_coding_task', {
      goal: '字'.repeat(2000),
      acceptance: Array.from({ length: 8 }, () => '条'.repeat(200)),
    })) as { status: string };
    expect(res.status).toBe('draft');
    expect(taskCount()).toBe(1);
    ask.release();
    await ask.askPromise;
  });

  it('条件 5：参数里写了别的项目 → 不认，照正在回答的对话取项目', async () => {
    const { runtime, conversations, projects, project } = setup();
    const other = projects.create({
      name: '合成项目二',
      rootPath: join(dir, 'project2'),
      description: null,
    });
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    const res = (await runtime.hermesTool('propose_coding_task', {
      goal: '加个文件',
      acceptance: ['有文件'],
      projectId: other.id,
      project: '合成项目二',
    })) as { taskId: string; project: string };
    expect(res.project).toBe('合成项目');
    const rows = db.prepare('SELECT project_id FROM coding_tasks').all() as Array<{
      project_id: string;
    }>;
    expect(rows).toEqual([{ project_id: project.id }]);
    ask.release();
    await ask.askPromise;
  });

  it('约束：草案不批准、不派发、不跑任何命令（回答结束后也一样）', async () => {
    let executorRuns = 0;
    let checks = 0;
    const executor = new FakeCodingExecutor();
    const original = executor.run.bind(executor);
    executor.run = async (task, workspace, signal) => {
      executorRuns += 1;
      return original(task, workspace, signal);
    };
    const runCheck = async () => {
      checks += 1;
      return { argv: ['node'], exitCode: 0, output: '', ran: true };
    };
    const { runtime, conversations, project } = setup({ executor, runCheck });
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    const res = (await runtime.hermesTool('propose_coding_task', {
      goal: '加一个 hello.txt',
      acceptance: ['项目里有 hello.txt'],
    })) as { taskId: string };
    const during = db
      .prepare('SELECT status, approval_id FROM coding_tasks WHERE id = ?')
      .get(res.taskId) as { status: string; approval_id: string | null };
    expect(during.status).toBe('draft');
    expect(during.approval_id).toBeNull();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM coding_approvals').get() as { n: number }).n,
    ).toBe(0);
    ask.release();
    await ask.askPromise;
    // 回答结束后也没有任何动静：没批准、没派发、没跑命令，还是草案
    const after = db
      .prepare('SELECT status, approval_id FROM coding_tasks WHERE id = ?')
      .get(res.taskId) as { status: string; approval_id: string | null };
    expect(after.status).toBe('draft');
    expect(after.approval_id).toBeNull();
    expect(executorRuns).toBe(0);
    expect(checks).toBe(0);
  });

  it('契约 4：验证命令留空的草案，验收回报里如实写「还没有独立验收」', async () => {
    const { runtime, conversations, todos, project } = setup();
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    const res = (await runtime.hermesTool('propose_coding_task', {
      goal: '把说明写清楚',
      acceptance: ['note.txt 里有一句话'],
      scope: 'note.txt',
    })) as { taskId: string };
    ask.release();
    await ask.askPromise;
    const [todo] = todos.list({ status: ['proposed'] }).filter((t) => t.linked_id === res.taskId);
    // 点「要做」走 D3 的自动派发；验证命令为空 → pending_accept 的回报如实写明
    await runtime.acceptTodo(todo!.id);
    await vi.waitFor(() => {
      const status = (
        db.prepare('SELECT status FROM coding_tasks WHERE id = ?').get(res.taskId) as {
          status: string;
        }
      ).status;
      expect(status).toBe('pending_accept');
    });
    const msgs = db
      .prepare('SELECT content, meta_json FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conv.id) as Array<{ content: string; meta_json: string }>;
    const report = msgs
      .map((m) => ({
        content: m.content,
        meta: JSON.parse(m.meta_json) as Record<string, unknown>,
      }))
      .find((m) => m.meta['kind'] === 'task_report');
    expect(report?.content).toContain('还没有独立验收');
  });

  it('整合方补：没写 scope 的草案派发后，改项目里的文件（含子目录）不算越界', async () => {
    const writer = {
      name: 'd1-writer',
      async run(_task: unknown, workspace: string) {
        writeFileSync(join(workspace, 'hello.txt'), '你好');
        mkdirSync(join(workspace, 'sub', 'deep'), { recursive: true });
        writeFileSync(join(workspace, 'sub', 'deep', 'x.txt'), '合成');
        return {
          claimedSuccess: true,
          summary: '写好了',
          changedPaths: ['hello.txt', 'sub/deep/x.txt'],
          testsModified: false,
          raw: '',
        };
      },
    };
    const { runtime, conversations, todos, project } = setup({
      executor: writer as unknown as FakeCodingExecutor,
    });
    const conv = conversations.create({ projectId: project.id });
    const ask = startAsk(runtime, conv.id, project.id);
    await waitActive(runtime, 1);
    const res = (await runtime.hermesTool('propose_coding_task', {
      goal: '加一个 hello.txt，写上你好',
      acceptance: ['项目里有 hello.txt，内容是你好'],
    })) as { taskId: string };
    ask.release();
    await ask.askPromise;
    const [todo] = todos.list({ status: ['proposed'] }).filter((t) => t.linked_id === res.taskId);
    await runtime.acceptTodo(todo!.id);
    await vi.waitFor(
      () => {
        const row = db
          .prepare('SELECT status, error FROM coding_tasks WHERE id = ?')
          .get(res.taskId) as { status: string; error: string | null };
        expect(row.error ?? '').not.toContain('超出批准范围');
        expect(row.status).toBe('pending_accept');
      },
      { timeout: 5000 },
    );
  });

  it('条件 6：名单、MCP 声明、本地服务放行都有这个工具', async () => {
    // 契约 1：HERMES_BRIDGE_TOOLS 名单里有 propose_coding_task
    expect(HERMES_BRIDGE_TOOLS).toContain('propose_coding_task');
    // 契约 1：Hermes 用的 MCP 服务同步声明它（替身服务记录注册与处理函数）
    const registered: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const stubServer = {
      registerTool: (
        name: string,
        def: { inputSchema: Record<string, unknown> },
        handler: (args: unknown) => Promise<unknown>,
      ) => {
        registered.push({ name, inputSchema: def.inputSchema });
        handlers.set(name, handler);
      },
    };
    const toolCalls: Array<[string, Record<string, unknown>]> = [];
    registerHermesBridgeTools(stubServer as never, async (name, args) => {
      toolCalls.push([name, args]);
      return { taskId: 'stub' };
    });
    expect(registered.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'search_memory',
        'get_evidence',
        'record_observation',
        'propose_coding_task',
      ]),
    );
    const def = registered.find((r) => r.name === 'propose_coding_task');
    expect(Object.keys(def?.inputSchema ?? {})).toEqual(
      expect.arrayContaining(['goal', 'acceptance', 'scope']),
    );
    // 注册的 schema 本身要校验输入（raw shape 的每个字段自带 safeParse，字段级核对）：
    // scope 声明成必填、acceptance 声明成字符串、上限写松，这里都会挂。
    const shape = (def?.inputSchema ?? {}) as Record<
      string,
      { safeParse: (value: unknown) => { success: boolean } }
    >;
    expect(shape['goal']!.safeParse('加个文件').success).toBe(true);
    expect(shape['goal']!.safeParse('字'.repeat(2000)).success).toBe(true); // 目标上限 2000 字，含
    expect(shape['goal']!.safeParse('字'.repeat(2001)).success).toBe(false);
    expect(shape['goal']!.safeParse(undefined).success).toBe(false); // 必填
    expect(shape['acceptance']!.safeParse(['有文件']).success).toBe(true);
    expect(shape['acceptance']!.safeParse(undefined).success).toBe(false); // 必填
    expect(shape['acceptance']!.safeParse('有文件').success).toBe(false); // 必须是数组
    expect(shape['acceptance']!.safeParse([]).success).toBe(false); // 至少 1 条
    expect(shape['acceptance']!.safeParse(Array.from({ length: 8 }, () => '条件')).success).toBe(
      true,
    ); // 上限 8 条，含
    expect(shape['acceptance']!.safeParse(Array.from({ length: 9 }, () => '条件')).success).toBe(
      false,
    );
    expect(shape['acceptance']!.safeParse(['']).success).toBe(false); // 单条至少 1 字
    expect(shape['acceptance']!.safeParse(['字'.repeat(200)]).success).toBe(true); // 单条上限 200 字，含
    expect(shape['acceptance']!.safeParse(['字'.repeat(201)]).success).toBe(false);
    expect(shape['scope']!.safeParse('docs').success).toBe(true);
    expect(shape['scope']!.safeParse(undefined).success).toBe(true); // scope 可省略
    // 真正调一次注册进去的处理函数：名称和参数要原样转给调用通道，返回值原样回来
    const forwarded = (await handlers.get('propose_coding_task')!({
      goal: '加个文件',
      acceptance: ['有文件'],
    })) as { content: Array<{ text: string }> };
    expect(toolCalls).toEqual([
      ['propose_coding_task', { goal: '加个文件', acceptance: ['有文件'] }],
    ]);
    expect(JSON.parse(forwarded.content[0]!.text)).toEqual({ taskId: 'stub' });
    // 契约 1：本地服务的 /api/hermes/tool 照名单放行
    let config: AppConfig = {
      ...defaultAppConfig(),
      localToken: 'local-token-'.padEnd(64, '1'),
      hermesBridge: { enabled: true, token: BRIDGE_TOKEN },
    };
    const calls: string[] = [];
    const server = new LocalServer({
      db,
      permissions: new PermissionService(db),
      sources: new SourceStore(db),
      vault: new Vault(join(dir, 'vault')),
      getConfig: () => config,
      updateConfig: (mutate) => {
        config = mutate(config);
      },
      hermesTool: async (name) => {
        calls.push(name);
        return { taskId: 'stub', status: 'draft' };
      },
    });
    const app: FastifyInstance = Fastify();
    await server.register(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/hermes/tool',
      headers: { authorization: `Bearer ${BRIDGE_TOKEN}` },
      payload: { name: 'propose_coding_task', args: { goal: 'g', acceptance: ['a'] } },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['propose_coding_task']);
    await app.close();
  });
});
