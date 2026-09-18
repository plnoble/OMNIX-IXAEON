/**
 * S1：Hermes 回答正文分段交给 onDelta；思考过程不转。
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
  const dir = mkdtempSync(join(tmpdir(), 'ixa-s1-exe-'));
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

describe('S1 Hermes 回答分段', () => {
  it('onDelta 只收到 message.delta 的三段正文，思考过程一段都没有', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixa-s1-'));
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
    const session = new AgentSession(db, adapter, broker, new FakeProvider('s1'), {
      mcpBridgedTools: [],
    });
    const got: string[] = [];
    const pending = session.run({
      goal: '逐字显示',
      projectId: null,
      onDelta: (t) => got.push(t),
    });
    const start = Date.now();
    while (spawns.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const s = spawns[0]!;
    const create = await waitMethod(s.outbound, 'session.create');
    s.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: 's-delta' } }) + '\n',
    );
    const submit = await waitMethod(s.outbound, 'prompt.submit');
    s.hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n');
    const emit = (type: string, payload: Record<string, unknown>) => {
      s.hostIn.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { type, session_id: 's-delta', payload },
        }) + '\n',
      );
    };
    emit('message.delta', { text: '一' });
    emit('message.delta', { text: '二' });
    emit('message.delta', { text: '三' });
    emit('reasoning.delta', { text: '不该出现的思考' });
    emit('message.complete', { text: '一二三完', status: 'complete' });
    const result = await pending;
    expect(got).toEqual(['一', '二', '三']);
    expect(got.join('')).not.toContain('思考');
    expect(result.answer).toBe('一二三完');
    adapter.disposeAll();
  });
});
