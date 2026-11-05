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
 *
 * 整合方 2026-10-05 改（为 D5a 让路，D5a 做完前后都成立）：
 * - 聊天里提的任务都带验收条件、没有验证命令，D5a 之后要先写验收测试再写实现，执行器会被调
 *   两次。「整合方补」那条的替身执行器原来每次被调都写项目文件，D5a 之后第一次（只许写测试）
 *   就会被判「写验收测试时改了别的文件」。现在它在只许写测试的那一步不写、照实说写不了。
 * - 「契约 4」的回报，D5a 之后不再是「还没有独立验收」，而是「验证没跑：<原因>」（替身执行器
 *   写不出验收测试）。这一条要钉的是「没有独立验证就不能说验证通过」，两种写法都算如实；
 *   D5a 之后的确切写法由 D5a 的验收（packages/core/test/acceptance/d5a-acceptance-first.test.ts
 *   「替身执行器」一组）钉住。
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
  type CoreDatabase,
} from '@ixaeon/core';
import { defaultAppConfig, HERMES_BRIDGE_TOOLS, type AppConfig } from '@ixaeon/contracts';
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
  // P6（2026-10-08）：绑着文件夹还得有有效的读取授权才派得了任务。这里的项目是「绑好了」的，补上授权；
  // 运行时也挂上授权服务（那道检查要问它）。
  const permissions = new PermissionService(db);
  permissions.grantFolder(root);
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
    permissions,
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

const taskCount = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM coding_tasks').get() as { n: number }).n;

describe('聊天里提编码任务草案', () => {
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
    // 整合方改（Q3，2026-10-29）：只为过类型检查，不改断言
    registerHermesBridgeTools(
      stubServer as never,
      (async (name: string, args: Record<string, unknown>) => {
        toolCalls.push([name, args]);
        return { taskId: 'stub' };
      }) as never,
    );
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
