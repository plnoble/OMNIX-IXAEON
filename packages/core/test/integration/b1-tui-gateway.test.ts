import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ErrorCodes } from '@ixaeon/contracts';
import {
  HermesRuntimeAdapter,
  JsonRpcStdio,
  TuiGatewaySession,
  type TuiTransport,
} from '../../src/index.js';

const previousExe = process.env.IXAEON_HERMES_EXE;

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
});

function stubTransport(): { hostIn: PassThrough; hostOut: PassThrough; transport: TuiTransport } {
  const hostIn = new PassThrough();
  const hostOut = new PassThrough();
  const transport: TuiTransport = {
    rpc: new JsonRpcStdio(hostIn, hostOut),
    kill() {
      hostIn.end();
      hostOut.end();
    },
  };
  return { hostIn, hostOut, transport };
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

async function waitMethod(
  outbound: string[],
  method: string,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lines = outbound.join('').split('\n').filter(Boolean);
    for (const line of lines) {
      const msg = parseLine(line);
      if (msg.method === method) return msg;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`未等到 JSON-RPC 方法 ${method}：${outbound.join('')}`);
}

/** 事件帧按真实契约：method='event'，事件名在 params.type。 */
function writeEvent(
  hostIn: PassThrough,
  type: string,
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  hostIn.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: { type, session_id: sessionId, payload },
    }) + '\n',
  );
}

describe('B1 TUI gateway JSON-RPC（协议替身，不是本机 Hermes）', () => {
  it('session.create → prompt.submit → message.complete 记为 hermes 终态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ixa-hermes-'));
    const fakeExe = join(dir, 'hermes.exe');
    writeFileSync(fakeExe, 'fake');
    chmodSync(fakeExe, 0o755);
    process.env.IXAEON_HERMES_EXE = fakeExe;

    const { hostIn, hostOut, transport } = stubTransport();
    const outbound: string[] = [];
    hostOut.on('data', (chunk: Buffer | string) => {
      outbound.push(String(chunk));
    });

    const adapter = new HermesRuntimeAdapter(undefined, () => transport);
    const started = adapter.start({
      runId: 'run-tui-1',
      goal: '读一条资料',
      contextRef: 'personal',
      allowedTools: ['search_memory'],
      permissionVersion: '1',
      budget: { maxToolCalls: 3, timeoutMs: 5_000 },
      idempotencyKey: 'k1',
    });

    const createMsg = await waitMethod(outbound, 'session.create');
    expect(createMsg.method).toBe('session.create');
    hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: createMsg.id, result: { session_id: 's1' } }) + '\n',
    );

    const submitMsg = await waitMethod(outbound, 'prompt.submit');
    expect(submitMsg.method).toBe('prompt.submit');
    expect((submitMsg.params as Record<string, unknown>).text).toBe('读一条资料');
    hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submitMsg.id, result: { ok: true } }) + '\n');
    writeEvent(hostIn, 'message.start', 's1', {});
    writeEvent(hostIn, 'message.complete', 's1', {
      text: '资料已读。这是协议替身，不是本机 Hermes。',
      status: 'complete',
    });

    const result = await started;
    expect(result.status).toBe('terminal');
    expect(result.answer).toMatch(/资料已读/);
    expect(result.events.some((e) => e.kind === 'terminal')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('session.interrupt 后状态为 cancelled，不当完成', async () => {
    const { hostIn, hostOut, transport } = stubTransport();
    const outbound: string[] = [];
    hostOut.on('data', (chunk: Buffer | string) => outbound.push(String(chunk)));
    const session = new TuiGatewaySession(transport, {
      runId: 'run-cancel',
      goal: '长时间任务',
      contextRef: 'personal',
      allowedTools: [],
      permissionVersion: '1',
      budget: { maxToolCalls: 1, timeoutMs: 5_000 },
      idempotencyKey: 'k2',
    });
    const running = session.run();
    const createMsg = await waitMethod(outbound, 'session.create');
    hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: createMsg.id, result: { session_id: 's-cancel' } }) +
        '\n',
    );
    await waitMethod(outbound, 'prompt.submit');
    session.interrupt();
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(outbound.join('')).toMatch(/session\.interrupt/);
    expect(result.events.some((e) => e.kind === 'cancelled')).toBe(true);
  });

  it('未装时 start 仍抛 NOT_FOUND，不把协议代码当已接通', async () => {
    delete process.env.IXAEON_HERMES_EXE;
    delete process.env.IXAEON_HERMES_HOME;
    const adapter = new HermesRuntimeAdapter();
    const caps = adapter.probe();
    expect(caps.engine).toBe('missing');
    expect(caps.session).toBe(false);
    await expect(
      adapter.start({
        runId: 'r-missing',
        goal: '任意',
        contextRef: 'c',
        allowedTools: [],
        permissionVersion: '1',
        budget: { maxToolCalls: 1, timeoutMs: 1000 },
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });
});
