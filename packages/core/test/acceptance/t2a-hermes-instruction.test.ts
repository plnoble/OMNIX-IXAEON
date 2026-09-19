/**
 * T2a 验收（整合方写死，执行方不改）：派给 Hermes 的这一轮带上「建议待办」约定。
 * 委派单：docs/委派/T2a-聊天里的待办.md
 * 协议替身（PassThrough），不启动本机 Hermes；看 prompt.submit 实际发出去的文字。
 */
import { afterEach, describe, expect, it } from 'vitest';
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
  SUGGESTED_TODOS_INSTRUCTION,
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

async function waitFor(
  outbound: string[],
  method: string,
): Promise<{ id?: number; params?: { text?: string } }> {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const hit = outbound
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: number; method?: string; params?: { text?: string } })
      .find((m) => m.method === method);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`没等到 ${method}`);
}

describe('派给 Hermes 的约定', () => {
  it('prompt.submit 的文字里带着「建议待办」约定', async () => {
    const dir = tempDir('ixa-t2a-');
    db = openDatabase(join(dir, 'ixaeon.db'));
    migrate(db);
    const exe = join(tempDir('ixa-t2a-exe-'), 'hermes.exe');
    writeFileSync(exe, 'fake');
    chmodSync(exe, 0o755);
    process.env.IXAEON_HERMES_EXE = exe;

    const spawns: Array<{ hostIn: PassThrough; outbound: string[] }> = [];
    const factory = () => {
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
    const session = new AgentSession(db, adapter, broker, new FakeProvider('t2a'), {
      mcpBridgedTools: [],
    });
    const pending = session.run({ goal: '我这周该做点什么？', projectId: null });

    const start = Date.now();
    while (spawns.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const s = spawns[0]!;
    const create = await waitFor(s.outbound, 'session.create');
    s.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: 's-t2a' } }) + '\n',
    );
    const submit = await waitFor(s.outbound, 'prompt.submit');
    expect(submit.params?.text).toContain('我这周该做点什么？');
    expect(submit.params?.text).toContain(SUGGESTED_TODOS_INSTRUCTION);

    s.hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n');
    s.hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.complete',
          session_id: 's-t2a',
          payload: { text: '好', status: 'complete' },
        },
      }) + '\n',
    );
    await pending;
    adapter.disposeAll();
  });
});
