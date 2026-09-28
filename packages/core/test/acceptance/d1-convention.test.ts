/**
 * D1 验收（规格 docs/委派/D1-聊天里提编码任务.md 条件 6 的约定文字部分）
 *
 * 记忆桥开着时，派给 Hermes 的这一轮附带「提编码任务草案」的约定：
 * 写的是模型真正看得到的名字 mcp__ixaeon__propose_coding_task，
 * 说明草案要用户点「要做」才开工、不要自己说已经做完。
 * 桥关着时不提这个工具。
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

/** 跑一轮替身会话，返回 prompt.submit 实际发出去的文字。 */
async function dispatchedPrompt(memoryBridge: boolean): Promise<string> {
  const dir = tempDir('ixa-d1-');
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
  const exe = join(tempDir('ixa-d1-exe-'), 'hermes.exe');
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
  const session = new AgentSession(db, adapter, broker, new FakeProvider('d1'), {
    mcpBridgedTools: [],
    memoryBridge,
  });
  const pending = session.run({
    goal: '在这个项目里加一个 hello.txt，写上你好',
    projectId: null,
  });

  const start = Date.now();
  while (spawns.length === 0 && Date.now() - start < 2000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const s = spawns[0]!;
  const create = await waitFor(s.outbound, 'session.create');
  s.hostIn.write(
    JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: 's-d1' } }) + '\n',
  );
  const submit = await waitFor(s.outbound, 'prompt.submit');
  const text = submit.params?.text ?? '';
  s.hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n');
  s.hostIn.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'message.complete',
        session_id: 's-d1',
        payload: { text: '好', status: 'complete' },
      },
    }) + '\n',
  );
  await pending;
  adapter.disposeAll();
  return text;
}

describe('提编码任务草案的约定', () => {
  it('记忆桥开着：约定里写 mcp__ixaeon__propose_coding_task，点「要做」才开工', async () => {
    const text = await dispatchedPrompt(true);
    expect(text).toContain('mcp__ixaeon__propose_coding_task');
    // 契约 6：什么时候该提（写代码、修 bug、加功能），写清目标和能验收的条件
    expect(text).toContain('写代码');
    expect(text).toContain('修 bug');
    expect(text).toContain('加功能');
    expect(text).toContain('写清目标');
    expect(text).toContain('验收');
    // 草案要点「要做」才开工，不要自己说已经做完
    expect(text).toContain('「要做」');
    expect(text).toContain('不要自己说已经做完');
    // 原有的记忆路由约定还在
    expect(text).toContain('mcp__ixaeon__search_memory');
  });

  it('记忆桥关着：全文不提这个工具', async () => {
    const text = await dispatchedPrompt(false);
    expect(text).not.toContain('propose_coding_task');
  });
});
