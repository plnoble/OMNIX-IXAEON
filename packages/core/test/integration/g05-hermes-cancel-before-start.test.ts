/**
 * G05 整合方抽查补（2026-09-26）：规格契约 2「每一次外发之前（启动 Hermes、调用 Core 模型）
 * 检查这一轮是否已被取消」。AppRuntime 在语义补齐之后查了一次，Core 模型路径每轮都查；
 * 但 AgentSession 里选材、拼近况之后直接启动 Hermes，没有再查——这段时间点「停止」，
 * 适配器里还没有在跑的会话，取消落空，Hermes 照样启动、照样外发。
 * 这里用协议替身数 Hermes 进程：取消之后一个都不许起。
 */
import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AgentSession,
  CodingOrchestrator,
  CoreToolBroker,
  FakeCodingExecutor,
  FakeProvider,
  HermesRuntimeAdapter,
  ItemService,
  JsonRpcStdio,
  ProjectService,
  SearchService,
  migrate,
  openDatabase,
  type CoreDatabase,
  type TuiTransport,
} from '../../src/index.js';

const previousExe = process.env.IXAEON_HERMES_EXE;
const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

it('选材期间已取消：不启动 Hermes，这一轮记成取消', async () => {
  const dir = tempDir('ixa-g05-hermes-');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const exe = join(tempDir('ixa-g05-exe-'), 'hermes.exe');
  writeFileSync(exe, 'fake');
  chmodSync(exe, 0o755);
  process.env.IXAEON_HERMES_EXE = exe;

  let spawned = 0;
  const factory = () => {
    spawned += 1;
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    return {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    } as TuiTransport;
  };
  const broker = new CoreToolBroker(
    db,
    new ItemService(db),
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    new ProjectService(db),
  );
  const adapter = new HermesRuntimeAdapter(broker, factory as never, () => ({
    chatModel: null,
    bridgeToken: null,
  }));
  const session = new AgentSession(db, adapter, broker, new FakeProvider('g05'), {
    mcpBridgedTools: [],
  });

  // 用户在这一轮真正启动引擎之前点了停止（适配器里还没有这个 runId 的会话）
  session.cancel('run-g05');
  const result = await session.run({
    goal: '合成问题',
    projectId: null,
    priorTurns: [],
    runId: 'run-g05',
  });

  expect(spawned).toBe(0);
  expect(result.notice).toContain('用户取消');
  const row = db.prepare('SELECT status FROM runtime_runs WHERE id = ?').get('run-g05') as
    { status: string } | undefined;
  expect(row?.status).toBe('cancelled');
  adapter.disposeAll();
});
