/**
 * 聊天用哪个模型由 IXAEON 决定（2026-09-18 用户反馈：改 Hermes 的 config.yaml 太麻烦）。
 *
 * 做法：启动网关时传 HERMES_MODEL / HERMES_INFERENCE_MODEL。Hermes 的
 * _env_model_seed() 优先于 config.yaml 的 model:，且这个启动种子按其设计不会被写回
 * 配置文件——所以 IXAEON 能决定聊天模型，又不动用户自己的 Hermes 设置。
 * 模型是启动参数，换了就必须重开网关进程，否则「设置没生效」。
 *
 * 全程协议替身（PassThrough），不启动本机 Hermes、不调模型。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  HermesRuntimeAdapter,
  JsonRpcStdio,
  hermesSpawnEnv,
  type TuiTransport,
} from '../../src/index.js';

const previousExe = process.env.IXAEON_HERMES_EXE;
const previousHome = process.env.IXAEON_HERMES_HOME;
const previousInstallerHome = process.env.HERMES_HOME;
const dirs: string[] = [];

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
  if (previousHome === undefined) delete process.env.IXAEON_HERMES_HOME;
  else process.env.IXAEON_HERMES_HOME = previousHome;
  if (previousInstallerHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousInstallerHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一个假的 hermes 可执行文件，只为让定位器认为「已安装」。 */
function fakeHermesExe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-chatmodel-'));
  dirs.push(dir);
  const exe = join(dir, 'hermes.exe');
  writeFileSync(exe, 'fake');
  chmodSync(exe, 0o755);
  return exe;
}

interface Spawned {
  env: Record<string, string>;
  hostIn: PassThrough;
  outbound: string[];
}

/** 记录每次「启动网关」的环境，并把该次会话驱动到终态。 */
function spawnRecorder(): {
  spawns: Spawned[];
  factory: (exe: string, args: string[], opts: { env?: Record<string, string> }) => TuiTransport;
} {
  const spawns: Spawned[] = [];
  const factory = (_exe: string, _args: string[], opts: { env?: Record<string, string> }) => {
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (chunk: Buffer | string) => outbound.push(String(chunk)));
    spawns.push({ env: opts.env ?? {}, hostIn, outbound });
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

/** 等第 nth 次（0 起）出现的某个请求——复用同一进程时，outbound 里还留着上一轮的旧消息。 */
async function waitMethod(
  outbound: string[],
  method: string,
  nth = 0,
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
    if (hits.length > nth) return hits[nth]!;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`未等到第 ${nth + 1} 次 ${method}：${outbound.join('')}`);
}

/** 把一次回合驱动到 message.complete。 */
async function completeTurn(s: Spawned, sessionId: string): Promise<void> {
  const create = await waitMethod(s.outbound, 'session.create');
  s.hostIn.write(
    JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: sessionId } }) + '\n',
  );
  const submit = await waitMethod(s.outbound, 'prompt.submit');
  s.hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n');
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

function runInput(runId: string) {
  return {
    runId,
    goal: '随便问一句',
    contextRef: 'personal',
    allowedTools: [],
    permissionVersion: '1',
    budget: { maxToolCalls: 2, timeoutMs: 5_000 },
    idempotencyKey: runId,
  };
}

describe('聊天模型由 IXAEON 决定', () => {
  it('启动环境里带上模型，同时保留工具集钉定', () => {
    const locator = { found: true, exe: 'python.exe', cwd: 'repo', home: 'home', reason: 't' };
    const env = hermesSpawnEnv(locator, { chatModel: 'grok-4.6' });
    expect(env.HERMES_MODEL).toBe('grok-4.6');
    expect(env.HERMES_INFERENCE_MODEL).toBe('grok-4.6');
    expect(env.HERMES_TUI_TOOLSETS).toBe('web,ixaeon');
  });

  it('没设模型：不写这两个变量，沿用 Hermes 自己的 config.yaml', () => {
    const locator = { found: true, exe: 'python.exe', cwd: 'repo', home: 'home', reason: 't' };
    for (const chatModel of [null, '', '   ']) {
      const env = hermesSpawnEnv(locator, { chatModel });
      expect(env.HERMES_MODEL, String(chatModel)).toBeUndefined();
      expect(env.HERMES_INFERENCE_MODEL, String(chatModel)).toBeUndefined();
    }
  });

  it('提问时把设置里的模型交给网关进程', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    const adapter = new HermesRuntimeAdapter(undefined, factory as never, () => 'grok-4.6');
    const started = adapter.start(runInput('run-1'));
    await waitMethod(spawns[0]!.outbound, 'session.create');
    await completeTurn(spawns[0]!, 's1');
    await started;
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.env.HERMES_MODEL).toBe('grok-4.6');
    adapter.disposeAll();
  });

  it('换了模型：下一问开新网关进程；没换则复用', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    let model = 'grok-4.6';
    const adapter = new HermesRuntimeAdapter(undefined, factory as never, () => model);

    const first = adapter.start(runInput('run-1'));
    await completeTurn(spawns[0]!, 's1');
    await first;

    // 同一模型：复用长驻会话，不再起进程
    const second = adapter.start(runInput('run-2'));
    const submit = await waitMethod(spawns[0]!.outbound, 'prompt.submit', 1);
    expect(spawns).toHaveLength(1);
    spawns[0]!.hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n',
    );
    spawns[0]!.hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.complete',
          session_id: 's1',
          payload: { text: '好', status: 'complete' },
        },
      }) + '\n',
    );
    await second;

    // 换模型：必须重开进程，并且新进程拿到新模型
    model = 'claude-opus-5';
    const third = adapter.start(runInput('run-3'));
    await completeTurn(spawns[1]!, 's2');
    await third;
    expect(spawns).toHaveLength(2);
    expect(spawns[1]!.env.HERMES_MODEL).toBe('claude-opus-5');
    adapter.disposeAll();
  });
});
