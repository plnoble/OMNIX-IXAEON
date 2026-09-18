/**
 * P1 会话预热（2026-09-18）。
 *
 * 真机时间线：新会话建好后 Hermes 要花 5–9 秒组装助手，期间没有任何输出。Hermes 在
 * session.create 时就在后台组装，所以提前建好会话，第一问直接复用即可省掉这段空等。
 *
 * 这里验证适配器层：预热 = 起进程 + session.create；第一问复用它（不再起进程、不再建会话，
 * 直接 prompt.submit）；启动参数变了或预热失败，第一问照常冷启动。协议替身，不启动真 Hermes。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { HermesRuntimeAdapter, JsonRpcStdio, type TuiTransport } from '../../src/index.js';

const previousExe = process.env.IXAEON_HERMES_EXE;
const dirs: string[] = [];

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeHermesExe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-prewarm-'));
  dirs.push(dir);
  const exe = join(dir, 'hermes.exe');
  writeFileSync(exe, 'fake');
  chmodSync(exe, 0o755);
  return exe;
}

interface Spawned {
  hostIn: PassThrough;
  outbound: string[];
}

function spawnRecorder() {
  const spawns: Spawned[] = [];
  const factory = () => {
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (c: Buffer | string) => outbound.push(String(c)));
    spawns.push({ hostIn, outbound });
    const transport: TuiTransport = {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    };
    return transport;
  };
  return { spawns, factory };
}

function sent(
  s: Spawned,
  method: string,
): Array<{ id?: number; params?: Record<string, unknown> }> {
  return s.outbound
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id?: number; method?: string; params?: Record<string, unknown> })
    .filter((m) => m.method === method);
}

async function waitSent(s: Spawned, method: string, nth = 0) {
  for (let i = 0; i < 200; i++) {
    const hits = sent(s, method);
    if (hits.length > nth) return hits[nth]!;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`未等到第 ${nth + 1} 次 ${method}`);
}

function reply(s: Spawned, id: number | undefined, result: unknown): void {
  s.hostIn.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function complete(s: Spawned, sessionId: string): void {
  s.hostIn.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'message.complete',
        session_id: sessionId,
        payload: { text: '好', status: 'complete' },
      },
    }) + '\n',
  );
}

function input(runId: string, permissionVersion = '1') {
  return {
    runId,
    goal: runId === 'prewarm' ? '' : '在吗',
    contextRef: 'personal',
    allowedTools: [],
    permissionVersion,
    budget: { maxToolCalls: 2, timeoutMs: 5_000 },
    idempotencyKey: runId,
  };
}

describe('会话预热', () => {
  it('预热只建会话不提问；第一问复用它：不再起进程、不再建会话，直接提交', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    const adapter = new HermesRuntimeAdapter(undefined, factory as never);

    const warming = adapter.prewarm(input('prewarm'));
    const create = await waitSent(spawns[0]!, 'session.create');
    reply(spawns[0]!, create.id, { session_id: 'warm-1' });
    expect(await warming).toBe(true);
    expect(sent(spawns[0]!, 'prompt.submit')).toHaveLength(0);

    const first = adapter.start(input('run-1'));
    const submit = await waitSent(spawns[0]!, 'prompt.submit');
    expect(submit.params?.session_id).toBe('warm-1');
    reply(spawns[0]!, submit.id, { ok: true });
    complete(spawns[0]!, 'warm-1');
    const r = await first;
    expect(r.status).toBe('terminal');
    expect(r.sessionId).toBe('warm-1');
    expect(spawns).toHaveLength(1);
    expect(sent(spawns[0]!, 'session.create')).toHaveLength(1);
    adapter.disposeAll();
  });

  it('重复预热不会多起进程', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    const adapter = new HermesRuntimeAdapter(undefined, factory as never);
    const warming = adapter.prewarm(input('prewarm'));
    const create = await waitSent(spawns[0]!, 'session.create');
    reply(spawns[0]!, create.id, { session_id: 'warm-1' });
    await warming;
    expect(await adapter.prewarm(input('prewarm'))).toBe(true);
    expect(spawns).toHaveLength(1);
    adapter.disposeAll();
  });

  it('预热之后换了聊天模型：第一问不复用旧进程，照常冷启动', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    let chatModel = 'model-a';
    const adapter = new HermesRuntimeAdapter(undefined, factory as never, () => ({
      chatModel,
      bridgeToken: null,
    }));
    const warming = adapter.prewarm(input('prewarm'));
    const create = await waitSent(spawns[0]!, 'session.create');
    reply(spawns[0]!, create.id, { session_id: 'warm-1' });
    await warming;

    chatModel = 'model-b';
    const first = adapter.start(input('run-1'));
    for (let i = 0; i < 100 && spawns.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(spawns).toHaveLength(2);
    const create2 = await waitSent(spawns[1]!, 'session.create');
    reply(spawns[1]!, create2.id, { session_id: 'cold-1' });
    const submit = await waitSent(spawns[1]!, 'prompt.submit');
    reply(spawns[1]!, submit.id, { ok: true });
    complete(spawns[1]!, 'cold-1');
    expect((await first).sessionId).toBe('cold-1');
    adapter.disposeAll();
  });

  it('权限版本变了（撤权/纠正之后）：预热的会话作废，第一问冷启动', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    const adapter = new HermesRuntimeAdapter(undefined, factory as never);
    const warming = adapter.prewarm(input('prewarm', '1'));
    const create = await waitSent(spawns[0]!, 'session.create');
    reply(spawns[0]!, create.id, { session_id: 'warm-1' });
    await warming;

    const first = adapter.start(input('run-1', '2'));
    for (let i = 0; i < 100 && spawns.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(spawns).toHaveLength(2);
    const create2 = await waitSent(spawns[1]!, 'session.create');
    reply(spawns[1]!, create2.id, { session_id: 'cold-1' });
    const submit = await waitSent(spawns[1]!, 'prompt.submit');
    reply(spawns[1]!, submit.id, { ok: true });
    complete(spawns[1]!, 'cold-1');
    expect((await first).sessionId).toBe('cold-1');
    adapter.disposeAll();
  });

  it('预热失败：报错但不留下坏会话，第一问照常冷启动', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    const adapter = new HermesRuntimeAdapter(undefined, factory as never);
    const warming = adapter.prewarm(input('prewarm'));
    const create = await waitSent(spawns[0]!, 'session.create');
    spawns[0]!.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: create.id, error: { code: -1, message: 'boom' } }) +
        '\n',
    );
    await expect(warming).rejects.toThrow();

    const first = adapter.start(input('run-1'));
    for (let i = 0; i < 100 && spawns.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(spawns).toHaveLength(2);
    const create2 = await waitSent(spawns[1]!, 'session.create');
    reply(spawns[1]!, create2.id, { session_id: 'cold-1' });
    const submit = await waitSent(spawns[1]!, 'prompt.submit');
    reply(spawns[1]!, submit.id, { ok: true });
    complete(spawns[1]!, 'cold-1');
    expect((await first).sessionId).toBe('cold-1');
    adapter.disposeAll();
  });
});
