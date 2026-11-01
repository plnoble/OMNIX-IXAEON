/**
 * SUB1 验收（核心：聊天真的走 magpie；规格 docs/委派/SUB1-直接接magpie.md 条件 3）。
 *
 * 条件 3：保存 magpie 预设、聊天模型选 `prov/m1` → 起 Hermes（替身）时它收到的
 *         网关地址是合成 magpie 的、Key 是 `magpie`、模型是 `prov/m1`。
 *
 * 做法照现有 `HERMES_MODEL`：只走启动环境，不写回 Hermes 的 config.yaml。Hermes 的
 * TUI 网关没有命令行参数，`tui_gateway.entry` 不接受 base-url / api-key；能用的只有
 * 环境变量。选 `lmstudio` 这一档（`LM_BASE_URL` / `LM_API_KEY`）的原因：
 * 它是 Hermes 里唯一的「本机 OpenAI 兼容端点」api_key 提供方，走 chat_completions，
 * 且带 `provider/model` 这种带斜杠的模型名不会被改写成别的网关（11-01 用真 Hermes +
 * 本机 magpie 问「只回复两个字母：OK」实测通过；`openrouter` 档也通，但那是聚合器
 * 语义，带 OpenRouter 专用参数）。这里用替身，不启动真 Hermes、不调模型。
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
const dirs: string[] = [];

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeHermesExe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixa-sub1-'));
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
    return {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    };
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
        payload: { text: 'OK', status: 'complete' },
      },
    }) + '\n',
  );
}

function runInput(runId: string) {
  return {
    runId,
    goal: '只回复两个字母：OK',
    contextRef: 'personal',
    allowedTools: [],
    permissionVersion: '1',
    budget: { maxToolCalls: 2, timeoutMs: 5_000 },
    idempotencyKey: runId,
  };
}

describe('SUB1 聊天走 magpie（条件 3）', () => {
  it('启动环境里带合成 magpie 的地址、Key magpie、模型 prov/m1；工具集钉定照旧', () => {
    const locator = { found: true, exe: 'python.exe', cwd: 'repo', home: 'home', reason: 't' };
    const env = hermesSpawnEnv(locator, {
      chatModel: 'prov/m1',
      chatBaseUrl: 'http://127.0.0.1:3425/v1',
      chatApiKey: 'magpie',
    });
    expect(env.HERMES_MODEL).toBe('prov/m1');
    expect(env.HERMES_INFERENCE_MODEL).toBe('prov/m1');
    expect(env.LM_BASE_URL).toBe('http://127.0.0.1:3425/v1');
    expect(env.LM_API_KEY).toBe('magpie');
    expect(env.HERMES_TUI_PROVIDER).toBe('lmstudio');
    expect(env.HERMES_TUI_TOOLSETS).toBe('web,ixaeon');
  });

  it('没设地址/模型时不动网关：不写 LM_* 与 provider，沿用 Hermes 自己的 config.yaml', () => {
    const locator = { found: true, exe: 'python.exe', cwd: 'repo', home: 'home', reason: 't' };
    for (const opts of [
      { chatModel: null, chatBaseUrl: 'http://127.0.0.1:3425/v1', chatApiKey: 'magpie' },
      { chatModel: 'prov/m1', chatBaseUrl: null, chatApiKey: 'magpie' },
      { chatModel: 'prov/m1', chatBaseUrl: '', chatApiKey: 'magpie' },
    ]) {
      const env = hermesSpawnEnv(locator, opts);
      expect(env.HERMES_TUI_PROVIDER, JSON.stringify(opts)).toBeUndefined();
      expect(env.LM_BASE_URL, JSON.stringify(opts)).toBeUndefined();
      expect(env.LM_API_KEY, JSON.stringify(opts)).toBeUndefined();
    }
    // 没配 Key 的本机网关（如 magpie 之外的本地端点）也照样走这个地址，只是不带 Key。
    const noKey = hermesSpawnEnv(locator, {
      chatModel: 'prov/m1',
      chatBaseUrl: 'http://127.0.0.1:3425/v1',
      chatApiKey: null,
    });
    expect(noKey.HERMES_TUI_PROVIDER).toBe('lmstudio');
    expect(noKey.LM_BASE_URL).toBe('http://127.0.0.1:3425/v1');
    expect(noKey.LM_API_KEY).toBeUndefined();
  });

  it('起 Hermes 替身时收到的是合成 magpie 的地址、Key、模型', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    const adapter = new HermesRuntimeAdapter(undefined, factory as never, () => ({
      chatModel: 'prov/m1',
      chatBaseUrl: 'http://127.0.0.1:3425/v1',
      chatApiKey: 'magpie',
      bridgeToken: null,
    }));
    const started = adapter.start(runInput('run-sub1'));
    await completeTurn(spawns[0]!, 's1');
    const result = await started;

    expect(result.status).toBe('terminal');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.env.LM_BASE_URL).toBe('http://127.0.0.1:3425/v1');
    expect(spawns[0]!.env.LM_API_KEY).toBe('magpie');
    expect(spawns[0]!.env.HERMES_MODEL).toBe('prov/m1');
    adapter.disposeAll();
  });

  it('换了网关地址 → 下一问必须重开网关进程（旧进程还连着旧网关）', async () => {
    process.env.IXAEON_HERMES_EXE = fakeHermesExe();
    const { spawns, factory } = spawnRecorder();
    let baseUrl = 'http://127.0.0.1:3425/v1';
    const adapter = new HermesRuntimeAdapter(undefined, factory as never, () => ({
      chatModel: 'prov/m1',
      chatBaseUrl: baseUrl,
      chatApiKey: 'magpie',
      bridgeToken: null,
    }));

    const first = adapter.start(runInput('run-1'));
    await completeTurn(spawns[0]!, 's1');
    await first;

    baseUrl = 'http://127.0.0.1:3999/v1';
    const second = adapter.start(runInput('run-2'));
    await completeTurn(spawns[1]!, 's2');
    await second;

    expect(spawns).toHaveLength(2);
    expect(spawns[1]!.env.LM_BASE_URL).toBe('http://127.0.0.1:3999/v1');
    adapter.disposeAll();
  });
});
