/**
 * 真机检查：用本机的真 Hermes（IXAEON 专属安装）在临时空库里问几个**合成的**问题，
 * 看模型实际怎么答。改了发给模型的提示词或约定的任务必须跑（2026-09-19 T2a 的约定
 * 就是这样查出「知识性问题也附一串待办」）。
 *
 *   node_modules/.bin/jiti scripts/real/hermes-ask.ts "问题一" "问题二" …
 *   node_modules/.bin/jiti scripts/real/hermes-ask.ts --project "开发请求" "知识性问题"
 *
 * 每个问题一个新的临时库和会话，互不影响；不碰用户的数据目录。会用掉少量模型额度。
 * 输出：引擎、模型、耗时、发给模型的约定（D1 后记忆桥开着时带提草案约定）、
 * 本轮工具调用（看到模型有没有调用 mcp__ixaeon__propose_coding_task）、
 * 回答末尾 400 字、按「建议待办」约定解析出的待办。
 * `--project`：在临时库里建一个合成项目，问题以项目对话身份问（记忆桥约定随行）。
 * 注意：桥的另一端（桌面端 /api/hermes/tool，固定端口 43191）不在本脚本里起——
 * 端口被本机正在运行的 IXAEON 占着。所以工具调用只能看到「模型发起没发起」，
 * 调用的完整回路（建出草案）由验收测试覆盖。
 * 问题要合成的、不带用户的个人信息。每类情况都要问到：该触发的、不该触发的。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSession,
  CodingOrchestrator,
  CoreToolBroker,
  FakeCodingExecutor,
  HermesRuntimeAdapter,
  ItemService,
  ProjectService,
  SearchService,
  TuiGatewaySession,
  extractSuggestedTodos,
  locateHermes,
  migrate,
  openDatabase,
  type RuntimeEvent,
} from '../../packages/core/src/index.js';

const argv = process.argv.slice(2);
const asProject = argv[0] === '--project';
if (asProject) argv.shift();
const questions = argv;
if (questions.length === 0) {
  console.error(
    '用法：node_modules/.bin/jiti scripts/real/hermes-ask.ts [--project] "问题一" "问题二" …',
  );
  process.exit(2);
}
if (!locateHermes().found) {
  console.error('本机没找到 IXAEON 专属的 Hermes 安装，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}

for (const q of questions) {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-hermes-ask-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  // --project：临时库里的合成项目，问题以项目对话身份问（D1 真机检查）。
  let projectId: string | null = null;
  if (asProject) {
    const root = join(dir, 'proj');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'note.txt'), '合成项目的合成文件\n');
    projectId = new ProjectService(db).create({
      name: '合成项目',
      rootPath: root,
      description: null,
    }).id;
  }
  const broker = new CoreToolBroker(
    db,
    new ItemService(db),
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    new ProjectService(db),
  );
  // 旁路记录：真正发给网关的 prompt.submit 文字 + 模型发起的工具调用。
  const prompts: string[] = [];
  const toolCalls: string[] = [];
  const factory = (
    exe: string,
    args: string[],
    opts: Parameters<typeof TuiGatewaySession.spawnProcess>[2],
  ) => {
    const transport = TuiGatewaySession.spawnProcess(exe, args, opts);
    const origRequest = transport.rpc.request.bind(transport.rpc);
    transport.rpc.request = ((method: string, params?: unknown) => {
      if (method === 'prompt.submit') {
        prompts.push(String((params as { text?: string } | undefined)?.text ?? ''));
      }
      return origRequest(method, params);
    }) as typeof transport.rpc.request;
    return transport;
  };
  const adapter = new HermesRuntimeAdapter(broker, factory as never, () => ({
    chatModel: null,
    bridgeToken: null,
  }));
  adapter.setEventSink((event: RuntimeEvent) => {
    if (event.kind === 'tool_request') toolCalls.push(String(event.payload['name'] ?? ''));
  });
  const session = new AgentSession(db, adapter, broker, null, {
    mcpBridgedTools: [],
    ...(asProject ? { memoryBridge: true } : {}),
  });
  const t0 = Date.now();
  try {
    const r = await session.run({ goal: q, projectId });
    const { todos } = extractSuggestedTodos(r.answer);
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log(`\n=== 问：${q}｜引擎 ${r.engine}｜模型 ${r.modelName}｜${sec} 秒`);
    const prompt = prompts.join('\n……\n');
    const hasConvention = prompt.includes('mcp__ixaeon__propose_coding_task');
    console.log(
      `--- 项目对话：${asProject ? '是（合成项目）' : '否'}；约定随行（含提草案句）：${prompt ? (hasConvention ? '是' : '否') : '未捕获'}`,
    );
    console.log(`--- 模型发起的工具调用（${toolCalls.length} 次）：${JSON.stringify(toolCalls)}`);
    console.log('--- 回答末尾 400 字：');
    console.log(r.answer.slice(-400));
    console.log(`--- 解析出的待办（${todos.length} 件）：${JSON.stringify(todos)}`);
  } catch (err) {
    console.log(`\n=== 问：${q}｜失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    adapter.disposeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(0);
