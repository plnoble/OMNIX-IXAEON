/**
 * P2：等待阶段只报 thinking / answering 各一次；思考内容不转。
 * 协议替身（PassThrough），不启动本机 Hermes。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AgentSession,
  CoreToolBroker,
  FakeCodingExecutor,
  FakeProvider,
  HermesRuntimeAdapter,
  ItemService,
  JsonRpcStdio,
  ProjectService,
  SearchService,
  CodingOrchestrator,
  migrate,
  openDatabase,
  type CoreDatabase,
  type TuiTransport,
} from '../../src/index.js';

const previousExe = process.env.IXAEON_HERMES_EXE;
const previousHome = process.env.IXAEON_HERMES_HOME;
const previousInstallerHome = process.env.HERMES_HOME;
const dirs: string[] = [];
let db: CoreDatabase | null = null;

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
  if (previousHome === undefined) delete process.env.IXAEON_HERMES_HOME;
  else process.env.IXAEON_HERMES_HOME = previousHome;
  if (previousInstallerHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousInstallerHome;
  if (db?.open) db.close();
  db = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeHermesExe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-p2-exe-'));
  dirs.push(dir);
  const exe = join(dir, 'hermes.exe');
  writeFileSync(exe, 'fake');
  chmodSync(exe, 0o755);
  return exe;
}

function spawnRecorder(): {
  spawns: Array<{ hostIn: PassThrough; outbound: string[] }>;
  factory: (exe: string, args: string[], opts: { env?: Record<string, string> }) => TuiTransport;
} {
  const spawns: Array<{ hostIn: PassThrough; outbound: string[] }> = [];
  const factory = (_exe: string, _args: string[], _opts: { env?: Record<string, string> }) => {
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (chunk: Buffer | string) => outbound.push(String(chunk)));
    spawns.push({ hostIn, outbound });
    return {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    } as TuiTransport;
  };
  return { spawns, factory };
}

async function waitMethod(
  outbound: string[],
  method: string,
  timeoutMs = 2000,
): Promise<{ id?: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hits = outbound
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: number; method?: string })
      .filter((m) => m.method === method);
    if (hits.length > 0) return hits[0]!;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`未等到 ${method}：${outbound.join('')}`);
}

async function drive(
  events: Array<{ type: string; payload: Record<string, unknown> }>,
): Promise<Array<'thinking' | 'answering'>> {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-p2-'));
  dirs.push(dir);
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  process.env.IXAEON_HERMES_EXE = fakeHermesExe();
  const broker = new CoreToolBroker(
    db,
    new ItemService(db),
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    new ProjectService(db),
  );
  const { spawns, factory } = spawnRecorder();
  const adapter = new HermesRuntimeAdapter(broker, factory as never, () => ({
    chatModel: null,
    bridgeToken: null,
  }));
  const session = new AgentSession(db, adapter, broker, new FakeProvider('p2'), {
    mcpBridgedTools: [],
  });
  const got: Array<'thinking' | 'answering'> = [];
  const pending = session.run({
    goal: '进度',
    projectId: null,
    onProgress: (p) => got.push(p),
  });
  const start = Date.now();
  while (spawns.length === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const s = spawns[0]!;
  const create = await waitMethod(s.outbound, 'session.create');
  s.hostIn.write(
    JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: 's-p2' } }) + '\n',
  );
  const submit = await waitMethod(s.outbound, 'prompt.submit');
  s.hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n');
  for (const ev of events) {
    s.hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: ev.type, session_id: 's-p2', payload: ev.payload },
      }) + '\n',
    );
  }
  await pending;
  adapter.disposeAll();
  return got;
}

describe('P2 Hermes 等待阶段', () => {
  it('onProgress 恰好收到 thinking 然后 answering，迟到思考忽略', async () => {
    const got = await drive([
      { type: 'message.start', payload: {} },
      { type: 'thinking.delta', payload: { text: '不该出现' } },
      { type: 'reasoning.delta', payload: { text: '也不该' } },
      { type: 'message.delta', payload: { text: '一' } },
      { type: 'message.delta', payload: { text: '二' } },
      { type: 'reasoning.delta', payload: { text: '迟到' } },
      { type: 'message.complete', payload: { text: '一二', status: 'complete' } },
    ]);
    expect(got).toEqual(['thinking', 'answering']);
  });

  it('没有 message.start、第一个事件就是 thinking.delta 时 thinking 也只报一次', async () => {
    const got = await drive([
      { type: 'thinking.delta', payload: { text: '想' } },
      { type: 'thinking.delta', payload: { text: '还在想' } },
      { type: 'message.complete', payload: { text: '好', status: 'complete' } },
    ]);
    expect(got).toEqual(['thinking']);
  });
});
