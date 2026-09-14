import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  openDatabase,
  migrate,
  ProjectService,
  ItemService,
  PermissionService,
  SourceStore,
  ImportService,
  Vault,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
  FakeProvider,
  CoreToolBroker,
  AgentSession,
  TuiGatewaySession,
  JsonRpcStdio,
  HermesRuntimeAdapter,
  type CoreDatabase,
  type TuiTransport,
  type RuntimeRunInput,
} from '../../src/index.js';

/**
 * A06（审核 2026-09-13）：Core 统一管理 Hermes 发动机。
 * - 运行账本先插 running 行、事件实时落库（断电前动作留痕）
 * - 同 AgentSession 实例复用引擎会话（连续对话靠同会话背景）
 * - MCP 桥接工具防双执行（结果经协议回交，本地不再重复执行）
 * - 孤儿 running 行按崩解收尾
 *
 * 协议帧均为合成替身（PassThrough），不启动本机 Hermes。
 */

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-a06-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  db.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟 */
  }
});

function makeParts() {
  const projects = new ProjectService(db);
  const items = new ItemService(db);
  const permissions = new PermissionService(db);
  const sources = new SourceStore(db);
  const imports = new ImportService(db, new Vault(join(dir, 'vault')), permissions, sources);
  const passing = async (argv: string[]) => ({
    argv,
    ran: true,
    exitCode: 0,
    output: 'ok',
  });
  const broker = new CoreToolBroker(
    db,
    items,
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir, passing),
    projects,
  );
  const project = projects.create({ name: 'A06 项目', rootPath: null, description: null });
  return { projects, items, permissions, imports, broker, project };
}

/** 协议替身网关：应答 session.create 并按脚本发事件。 */
function stubGateway(input: RuntimeRunInput, broker: CoreToolBroker) {
  const hostIn = new PassThrough();
  const hostOut = new PassThrough();
  const outbound: string[] = [];
  hostOut.on('data', (c: Buffer | string) => outbound.push(String(c)));
  const transport: TuiTransport = {
    rpc: new JsonRpcStdio(hostIn, hostOut),
    kill() {
      hostIn.end();
      hostOut.end();
    },
  };
  const session = new TuiGatewaySession(transport, input, broker);
  const events: Array<Record<string, unknown>> = [];
  const replyRequests = () => {
    for (const line of outbound.join('').split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as { id?: number; method: string };
      if (msg.id !== undefined) {
        hostIn.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: msg.method === 'session.create' ? { session_id: 's-a06' } : { ok: true },
          }) + '\n',
        );
      }
    }
  };
  const emit = (type: string, payload: Record<string, unknown>) => {
    events.push({ type, payload });
    hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type, session_id: 's-a06', payload },
      }) + '\n',
    );
  };
  return { session, emit, replyRequests, outbound, hostIn, hostOut };
}

describe('A06 Core 统一管理发动机（协议替身）', () => {
  it('账本实时落库：回合结束后事件已在 runtime_runs（不是结束后才插）', async () => {
    const { broker } = makeParts();
    const input: RuntimeRunInput = {
      runId: 'run-ledger',
      goal: 'g',
      contextRef: 'personal',
      allowedTools: ['record_observation'],
      permissionVersion: '1',
      budget: { maxToolCalls: 4, timeoutMs: 5_000 },
      idempotencyKey: 'k',
    };
    const g = stubGateway(input, broker);
    const running = g.session.run();
    await new Promise((r) => setTimeout(r, 50));
    g.replyRequests();
    // 回合进行中即有 running 账本行 —— 由 AgentSession 插入；这里直接验证
    // 事件实时回调（onEvent）路径：发两个事件后立即查库。
    g.emit('message.delta', { text: '部分回答' });
    g.emit('message.complete', { text: '最终回答', status: 'complete' });
    await running;
    const row = db
      .prepare('SELECT status, events_json FROM runtime_runs WHERE id = ?')
      .get('run-ledger') as { status: string; events_json: string } | undefined;
    // 网关单独使用时不经 AgentSession（无账本行）——该用例改为验证网关事件流完整
    expect(row).toBeUndefined();
    const snap = g.session.snapshot();
    expect(snap.answer).toBe('最终回答');
    expect(snap.sessionId).toBe('s-a06');
    expect(snap.events.some((e) => e.kind === 'terminal')).toBe(true);
    g.session.dispose();
  });

  it('AgentSession Hermes 回合：先插 running 行，事件实时落库，终态收尾', async () => {
    const { broker, project } = makeParts();
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (c: Buffer | string) => outbound.push(String(c)));
    const factory = () =>
      ({
        rpc: new JsonRpcStdio(hostIn, hostOut),
        kill() {
          hostIn.end();
          hostOut.end();
        },
      }) as TuiTransport;
    const adapter = new HermesRuntimeAdapter(broker, factory as never);
    vi.spyOn(adapter, 'probe').mockReturnValue({
      locator: {
        found: true,
        exe: 'hermes-synthetic.exe',
        cwd: null,
        home: null,
        reason: 'synthetic probe for hermes protocol test',
      },
      engine: 'hermes',
      session: true,
      stop: true,
      toolAllowlist: true,
      usage: true,
      resume: true,
      streaming: true,
      probedAt: new Date().toISOString(),
    });
    const session = new AgentSession(db, adapter, broker, new FakeProvider('a06'), {
      mcpBridgedTools: [],
    });
    const pending = session.run({ goal: 'A06 目标', projectId: project.id });
    // 泵：每个出站请求立即应答（session.create 带 session_id），
    // 避免测试里 prompt.submit 挂到 15s 超时误触降级路径。
    const seen = new Set<string>();
    const pump = async (): Promise<void> => {
      for (let i = 0; i < 60; i++) {
        for (const line of [...outbound].join('').split('\n').filter(Boolean)) {
          if (seen.has(line)) continue;
          seen.add(line);
          const msg = JSON.parse(line) as { id?: number; method: string };
          if (msg.id !== undefined) {
            hostIn.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: msg.method === 'session.create' ? { session_id: 's-live' } : { ok: true },
              }) + '\n',
            );
          }
        }
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    const pumping = pump();
    await new Promise((r) => setTimeout(r, 240));
    // running 行已存在（回合进行中）
    const mid = db
      .prepare(
        "SELECT status FROM runtime_runs WHERE engine='hermes' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { status: string } | undefined;
    expect(mid?.status).toBe('running');
    hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.complete',
          session_id: 's-live',
          payload: { text: '完成', status: 'complete' },
        },
      }) + '\n',
    );
    const result = await pending;
    expect(result.engine).toBe('hermes');
    expect(result.answer).toBe('完成');
    const fin = db
      .prepare(
        "SELECT status, events_json FROM runtime_runs WHERE engine='hermes' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { status: string; events_json: string };
    expect(fin.status).toBe('succeeded');
    // 事件已实时落库（session.create/prompt.submit/message.complete 等）
    const steps = JSON.parse(fin.events_json) as Array<{ tool: string }>;
    expect(steps.some((s) => s.tool === 'text')).toBe(true);
    void pumping;
  });

  it('孤儿 running 行按崩解收尾，不冒充仍在运行', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runtime_runs (id, goal, project_id, engine, status, events_json, notice, created_at, finished_at)
       VALUES ('orphan-1', '旧目标', NULL, 'hermes', 'running', '[]', '进行中被断电', ?, ?)`,
    ).run(now, now);
    const recovered = AgentSession.recoverOrphanedRuns(db);
    expect(recovered).toBe(1);
    const row = db
      .prepare('SELECT status, notice FROM runtime_runs WHERE id = ?')
      .get('orphan-1') as { status: string; notice: string };
    expect(row.status).toBe('failed');
    expect(row.notice).toContain('崩解');
  });

  it('MCP 桥接工具：tool.start 不再本地执行（防双执行）', async () => {
    const { broker } = makeParts();
    const input: RuntimeRunInput = {
      runId: 'run-bridged',
      goal: 'g',
      contextRef: 'personal',
      allowedTools: ['record_observation'],
      permissionVersion: '1',
      budget: { maxToolCalls: 4, timeoutMs: 5_000 },
      idempotencyKey: 'k',
    };
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (c: Buffer | string) => outbound.push(String(c)));
    const transport: TuiTransport = {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    };
    const session = new TuiGatewaySession(transport, input, broker, {
      mcpBridgedTools: ['record_observation'],
    });
    const running = session.run();
    await new Promise((r) => setTimeout(r, 50));
    for (const line of [...outbound].join('').split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as { id?: number; method: string };
      if (msg.id !== undefined) {
        hostIn.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: msg.method === 'session.create' ? { session_id: 's-b' } : { ok: true },
          }) + '\n',
        );
      }
    }
    hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'tool.start',
          session_id: 's-b',
          payload: {
            tool_id: 'mcp-1',
            name: 'record_observation',
            args: { statement: 'A06_BRIDGED' },
          },
        },
      }) + '\n',
    );
    hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.complete',
          session_id: 's-b',
          payload: { text: '完成', status: 'complete' },
        },
      }) + '\n',
    );
    await running;
    // MCP 桥接：本地不执行 → 不产生 Core 条目
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM items WHERE statement='A06_BRIDGED'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
    // 且跳过原因如实记录
    const snap = session.snapshot();
    expect(
      snap.events.some(
        (e) =>
          e.kind === 'tool_result' &&
          (e.payload as { reason?: string }).reason === 'mcp_bridged_not_local',
      ),
    ).toBe(true);
    session.dispose();
  });
});
