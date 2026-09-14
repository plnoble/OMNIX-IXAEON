import { describe, it, expect } from 'vitest';
import {
  locateHermes,
  HermesRuntimeAdapter,
  AgentSession,
  CoreToolBroker,
  ItemService,
  ProjectService,
  SearchService,
  CodingOrchestrator,
  FakeCodingExecutor,
} from '../../src/index.js';
import { openDatabase, migrate } from '../../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A06 真机 Hermes 端到端集成测试（直接经 HermesRuntimeAdapter）。
 * 仅当本机装有真 Hermes 时运行（通过 locator 判定）。
 */

const locator = locateHermes();
const wantReal = process.env.IXAEON_REAL_HERMES === '1';

describe.skipIf(!locator.found || !wantReal)('A06 真机 Hermes 直接接入验证', () => {
  it('真 Hermes 单轮对话：session.create → prompt.submit → message.complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-hermes-real-'));
    const db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);
    const projects = new ProjectService(db);
    const items = new ItemService(db);
    const broker = new CoreToolBroker(
      db,
      items,
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
      projects,
    );

    const adapter = new HermesRuntimeAdapter(broker);
    const events: string[] = [];
    adapter.setEventSink((e) => events.push(`${e.seq}:${e.kind}`));

    const result = await adapter.start({
      runId: 'real-run-1',
      goal: '只回答一个词：IXAEON_REAL_VERIFIED',
      contextRef: 'personal',
      allowedTools: [],
      permissionVersion: '1',
      budget: { maxToolCalls: 2, timeoutMs: 120_000 },
      idempotencyKey: 'real-k1',
    });

    expect(result.status).toBe('terminal');
    expect(result.answer).toContain('IXAEON_REAL_VERIFIED');
    expect(result.modelName).toBe('gemini-3.7-flash-tiered');
    expect(result.sessionId).toBeTruthy();
    // 事件实时 sink 收到事件
    expect(events.length).toBeGreaterThan(0);

    // 第二轮（同 adapter 实例复用长驻会话）
    const result2 = await adapter.start({
      runId: 'real-run-2',
      goal: '我上一句让你回答了什么？只回答那个词。',
      contextRef: 'personal',
      allowedTools: [],
      permissionVersion: '1',
      budget: { maxToolCalls: 2, timeoutMs: 120_000 },
      idempotencyKey: 'real-k2',
    });

    expect(result2.status).toBe('terminal');
    expect(result2.answer).toContain('IXAEON_REAL_VERIFIED');
    // 同一 sessionId 复用
    expect(result2.sessionId).toBe(result.sessionId);

    adapter.disposeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it('AgentSession + 真 Hermes：运行账本先插 running 行，终态收尾为 succeeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-hermes-agent-'));
    const db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);
    const projects = new ProjectService(db);
    const items = new ItemService(db);
    const broker = new CoreToolBroker(
      db,
      items,
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
      projects,
    );

    const adapter = new HermesRuntimeAdapter(broker);
    const session = new AgentSession(db, adapter, broker, null, {
      mcpBridgedTools: ['record_observation', 'get_evidence'],
    });

    const pending = session.run({
      goal: '只回答一个词：AGENT_LEDGER_VERIFIED',
      projectId: null,
    });

    // 回合进行中：先插 running 行（轮询查库，必须观察到 running 状态）
    let sawRunning = false;
    for (let i = 0; i < 40; i++) {
      const row = db
        .prepare(
          "SELECT status FROM runtime_runs WHERE engine='hermes' ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { status: string } | undefined;
      if (row && row.status === 'running') {
        sawRunning = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sawRunning).toBe(true);

    const result = await pending;
    expect(result.engine).toBe('hermes');
    expect(result.answer).toContain('AGENT_LEDGER_VERIFIED');
    expect(result.modelName).toBe('gemini-3.7-flash-tiered');

    // 终态收尾为 succeeded
    const fin = db
      .prepare(
        "SELECT status, events_json, notice FROM runtime_runs WHERE engine='hermes' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { status: string; events_json: string; notice: string };
    expect(fin.status).toBe('succeeded');
    expect(fin.notice).toContain('Hermes TUI gateway');
    const steps = JSON.parse(fin.events_json) as unknown[];
    expect(steps.length).toBeGreaterThan(0);

    adapter.disposeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
