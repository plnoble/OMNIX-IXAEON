/**
 * 真机检查：用本机的真 Hermes（IXAEON 专属安装）在临时空库里问几个**合成的**问题，
 * 看模型实际怎么答。改了发给模型的提示词或约定的任务必须跑（2026-09-19 T2a 的约定
 * 就是这样查出「知识性问题也附一串待办」）。
 *
 *   node_modules/.bin/jiti scripts/real/hermes-ask.ts "问题一" "问题二" …
 *   node_modules/.bin/jiti scripts/real/hermes-ask.ts --project "开发请求" "知识性问题"
 *
 * 每个问题一个新的临时库和会话，互不影响；不碰用户的数据目录。会用掉少量模型额度。
 * `--project`：临时库里建一个合成项目，问题以项目对话身份问（D1 真机检查），并搭起
 * **完整调用链**：临时端口上的本地服务（真实 LocalServer 路由与令牌校验 + 真实
 * AppRuntime.hermesTool）← 真实 MCP 桥服务（apps/mcp hermes 档，IXAEON_DESKTOP_PORT
 * 指向临时端口）← 真 Hermes（临时 HERMES_HOME 的合成 config.yaml 登记 mcp_servers）
 * ← 模型调 mcp__ixaeon__propose_coding_task → 草案落库 + 待办卡。用户的 Hermes 配置
 * 与桌面端口（43191）都不碰。需要先 build（verify 或 scripts/build.mjs 产出
 * apps/mcp/dist）。
 * 问题要合成的、不带用户的个人信息。每类情况都要问到：该触发的、不该触发的。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type FastifyDefault from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  AgentSession,
  CodingOrchestrator,
  ConversationStore,
  CoreToolBroker,
  FakeCodingExecutor,
  HermesRuntimeAdapter,
  ItemService,
  PermissionService,
  ProjectService,
  SearchService,
  SourceStore,
  TodoStore,
  Vault,
  locateHermes,
  migrate,
  openDatabase,
} from '../../packages/core/src/index.js';
import { AppRuntime } from '../../apps/desktop/src/main/appRuntime.js';
import { LocalServer } from '../../apps/desktop/src/main/server/localServer.js';

// fastify 是 apps/desktop 的依赖（pnpm 严格隔离），经它的路径借。
const desktopRequire = createRequire(
  join(import.meta.dirname, '..', '..', 'apps', 'desktop', 'package.json'),
);
const Fastify = desktopRequire('fastify') as typeof FastifyDefault;

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
const real = locateHermes();
if (!real.found || !real.exe) {
  console.error('本机没找到 IXAEON 专属的 Hermes 安装，没法做真机检查（如实写进交付说明）。');
  process.exit(2);
}
const repoMcp = join(import.meta.dirname, '..', '..', 'apps', 'mcp', 'dist', 'index.mjs');
if (asProject && !existsSync(repoMcp)) {
  console.error('apps/mcp/dist 不存在：先跑 node scripts/build.mjs（或 verify）再真机检查。');
  process.exit(2);
}

/** 完整桥链的本地端：随机端口上的真实 LocalServer + 真实 AppRuntime.hermesTool。 */
async function startBridgeServer(dir: string): Promise<{
  port: number;
  token: string;
  close: () => Promise<void>;
}> {
  const db = openDatabase(join(dir, 'bridge.db'));
  migrate(db);
  const token = 'real-check-bridge-token-'.padEnd(64, '0');
  const runtime = Object.create(AppRuntime.prototype) as AppRuntime;
  Object.assign(runtime, {
    db,
    conversations: new ConversationStore(db),
    todos: new TodoStore(db),
    coding: new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    items: new ItemService(db),
    search: new SearchService(db),
    projects: new ProjectService(db),
    askSessions: new Map(),
    activeAskRuns: new Map(),
    cancelledAskRuns: new Set(),
    askDeltaSink: null,
    askProgressSink: null,
    getProvider: () => null,
    hermesFound: () => false,
    getTinyFishFetcher: () => null,
    getWebSearchExecutor: () => null,
    ensureAskCapturePermission: () => null,
    semanticIndex: null,
    semanticBackfillRun: null,
    logger: { warn: () => undefined, info: () => undefined },
    kickSemanticBackfill: () => Promise.resolve(),
  });
  const config = { localToken: token, hermesBridge: { enabled: true, token } };
  const server = new LocalServer({
    db,
    permissions: new PermissionService(db),
    sources: new SourceStore(db),
    vault: new Vault(join(dir, 'vault')),
    getConfig: () => config,
    updateConfig: () => undefined,
    hermesTool: (name: string, args: Record<string, unknown>) => runtime.hermesTool(name, args),
  });
  const app: FastifyInstance = Fastify();
  await server.register(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    port: (app.server.address() as { port: number }).port,
    token,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

for (const q of questions) {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-hermes-ask-'));
  const db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  let adapterRef: HermesRuntimeAdapter | null = null;
  let projectId: string | null = null;
  let bridge: Awaited<ReturnType<typeof startBridgeServer>> | null = null;
  const savedHome = process.env.HERMES_HOME;
  const savedIxHome = process.env.IXAEON_HERMES_HOME;
  const savedExe = process.env.IXAEON_HERMES_EXE;
  const t0 = Date.now();
  try {
    if (asProject) {
      const root = join(dir, 'proj');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'note.txt'), '合成项目的合成文件\n');
      projectId = new ProjectService(db).create({
        name: '合成项目',
        rootPath: root,
        description: null,
      }).id;
      bridge = await startBridgeServer(join(dir, 'bridge'));
      // Hermes 用临时 HOME：合成 config.yaml＝用户配置原样克隆（模型网关等照常可用，
      // 含密钥但只进临时文件、用完即删、不打印）＋追加 mcp_servers.ixaeon 登记
      // 我们的 MCP 桥（指向临时端口）。
      const userCfg = real.home ? join(real.home, 'config.yaml') : '';
      if (!userCfg || !existsSync(userCfg)) {
        console.error('找不到用户 Hermes 的 config.yaml，没法做完整链真机检查。');
        process.exit(2);
      }
      const baseCfg = readFileSync(userCfg, 'utf8');
      const hermesHome = join(dir, 'hermes-home');
      mkdirSync(hermesHome, { recursive: true });
      const q = (s: string): string => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      // 接手补充（prep）：真实 Hermes 的认证多半由启动环境的变量注入（config.yaml
      // 里通常没有密钥行）——克隆到临时 HOME 时把这些占位符从当前环境展开，密钥
      // 只进临时文件、用完即删、不打印；环境里没有的变量原样保留。
      const expandEnv = (cfg: string): string =>
        cfg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (raw, name) =>
          process.env[name] !== undefined ? (process.env[name] as string) : raw,
        );
      const yaml =
        expandEnv(baseCfg.trimEnd()) +
        '\n' +
        [
          'mcp_servers:',
          '  ixaeon:',
          `    command: ${q(process.execPath)}`,
          `    args: [${q(repoMcp)}]`,
          '    env:',
          '      IXAEON_MCP_PROFILE: hermes',
          `      IXAEON_HERMES_TOKEN: ${bridge.token}`,
          `      IXAEON_DESKTOP_PORT: "${bridge.port}"`,
          '    enabled: true',
          '',
        ].join('\n');
      writeFileSync(join(hermesHome, 'config.yaml'), yaml);
      process.env.HERMES_HOME = hermesHome;
      process.env.IXAEON_HERMES_HOME = hermesHome;
      process.env.IXAEON_HERMES_EXE = real.exe;
    }
    const broker = new CoreToolBroker(
      db,
      new ItemService(db),
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
      new ProjectService(db),
    );
    const toolCalls: string[] = [];
    const adapter = new HermesRuntimeAdapter(broker, undefined, () => ({
      chatModel: null,
      // MCP 令牌已写进合成配置，不走网关环境展开。
      bridgeToken: null,
    }));
    adapterRef = adapter;
    adapter.setEventSink((event) => {
      if (event.kind === 'tool_request') toolCalls.push(String(event.payload['name'] ?? ''));
    });
    const session = new AgentSession(db, adapter, broker, null, {
      mcpBridgedTools: [],
      ...(asProject ? { memoryBridge: true } : {}),
    });
    const r = await session.run({ goal: q, projectId });
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log(`\n=== 问：${q}｜引擎 ${r.engine}｜模型 ${r.modelName}｜${sec} 秒`);
    console.log(
      `--- 项目对话：${asProject ? '是（合成项目，完整桥链：临时端口本地服务 + MCP 桥 + 真 Hermes）' : '否'}；本轮工具调用（${toolCalls.length} 次）：${JSON.stringify(toolCalls)}`,
    );
    const drafts = db
      .prepare('SELECT id, goal, status, acceptance_json FROM coding_tasks ORDER BY created_at')
      .all() as Array<{
      id: string;
      goal: string;
      status: string;
      acceptance_json: string | null;
    }>;
    console.log(`--- 编码任务草案（${drafts.length} 条）：`);
    for (const d of drafts) {
      const acc = JSON.parse(d.acceptance_json ?? '[]') as string[];
      console.log(
        `    ${d.id.slice(0, 8)} ${d.status}｜${d.goal.slice(0, 60)}｜验收条件 ${acc.length} 条：${acc.map((a) => a.slice(0, 30)).join('；')}`,
      );
    }
    const todos = new TodoStore(db)
      .list({ status: ['proposed', 'accepted'] })
      .filter((t) => t.linked_kind === 'coding_task');
    console.log(
      `--- 草案的待办卡（${todos.length} 张）：${todos.map((t) => t.title.slice(0, 40)).join('｜')}`,
    );
    console.log('--- 回答末尾 400 字：');
    console.log(r.answer.slice(-400));
  } catch (err) {
    console.log(`\n=== 问：${q}｜失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (savedHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = savedHome;
    if (savedIxHome === undefined) delete process.env.IXAEON_HERMES_HOME;
    else process.env.IXAEON_HERMES_HOME = savedIxHome;
    if (savedExe === undefined) delete process.env.IXAEON_HERMES_EXE;
    else process.env.IXAEON_HERMES_EXE = savedExe;
    adapterRef?.disposeAll();
    await bridge?.close().catch(() => undefined);
    db.close();
    // Windows 上刚退出的网关/MCP 进程可能还占着文件句柄：删不掉就等一下再试。
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}
process.exit(0);
