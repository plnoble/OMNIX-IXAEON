/**
 * 聊天失败的处理（2026-09-18 真机回归）。
 *
 * 真机记录：后台分析占着模型网关账号的并发名额，聊天请求被 429 拒绝；Hermes 重试到
 * 超时后，Core 兜底用同一个账号又撞 429，两遍加起来等了 5 分钟才报「模型动作失败：
 * API 错误 429 {...}」——而用户明明在设置里测过模型是通的。
 *
 * 这里验证：
 * - 回合已交给 Hermes 后失败：如实报错，不再换 Core 整轮重跑；
 * - Hermes 根本没起来：才走 Core 兜底，并且兜底说明里带上 Hermes 没起来的原因；
 * - 错误说人话（429 / 超时 / 401 / 5xx）；
 * - 后台任务队列能给聊天让路：让路期间不开新任务，被打断的任务回到排队、不计失败。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSession,
  CodingOrchestrator,
  CoreToolBroker,
  FakeCodingExecutor,
  FakeProvider,
  HermesRuntimeAdapter,
  ItemService,
  JobQueue,
  JsonRpcStdio,
  ProjectService,
  SearchService,
  migrate,
  openDatabase,
  type CoreDatabase,
  type TuiTransport,
} from '../../src/index.js';
import { explainModelFailure } from '../../src/runtime/modelErrors.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-chatfail-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
  migrate(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeSession(startError: Error) {
  const broker = new CoreToolBroker(
    db,
    new ItemService(db),
    new SearchService(db),
    new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
    new ProjectService(db),
  );
  const adapter = new HermesRuntimeAdapter(broker);
  vi.spyOn(adapter, 'probe').mockReturnValue({
    locator: { found: true, exe: 'hermes.exe', cwd: null, home: null, reason: 't' },
    engine: 'hermes',
    session: true,
    stop: true,
    toolAllowlist: false,
    usage: false,
    resume: true,
    streaming: true,
    probedAt: new Date().toISOString(),
  });
  vi.spyOn(adapter, 'start').mockRejectedValue(startError);
  const provider = new FakeProvider('core-fallback-model');
  const session = new AgentSession(db, adapter, broker, provider);
  return { session, provider };
}

function stageError(message: string, stage: 'turn' | 'startup'): Error {
  const err = new Error(message) as Error & { hermesStage: string };
  err.hermesStage = stage;
  return err;
}

describe('回合交给 Hermes 之后才失败：如实报错，不换 Core 重跑', () => {
  it('模型网关 429：直接报错并说人话，Core 兜底一次都不调', async () => {
    const { session, provider } = makeSession(
      stageError(
        'API 错误 429: {"error":{"message":"Concurrency limit exceeded for account","code":"gateway_concurrency_limit"}}',
        'turn',
      ),
    );
    await expect(session.run({ goal: '我最近在忙什么？', projectId: null })).rejects.toThrow(
      /这一轮没答完：模型网关同时处理的请求数到上限了.*原始错误：API 错误 429/,
    );
    expect(provider.structuredCalls).toHaveLength(0);
    const row = db.prepare('SELECT engine, status, notice FROM runtime_runs').get() as {
      engine: string;
      status: string;
      notice: string;
    };
    expect(row).toMatchObject({ engine: 'hermes', status: 'failed' });
    expect(row.notice).toMatch(/Concurrency limit exceeded/); // 原文留在账本里
  });

  it('超时：提示换个快一点的聊天模型', async () => {
    const { session } = makeSession(stageError('TUI gateway 会话超时', 'turn'));
    await expect(session.run({ goal: '在吗', projectId: null })).rejects.toThrow(/聊天模型/);
  });
});

describe('Hermes 根本没起来：才走 Core 兜底，并说明原因', () => {
  it('启动失败的原因写进兜底说明，不再被覆盖', async () => {
    const { session, provider } = makeSession(stageError('spawn hermes.exe ENOENT', 'startup'));
    provider.enqueueStructured({ tool: 'answer', args: { text: '兜底回答' } });
    const r = await session.run({ goal: '在吗', projectId: null });
    expect(r.engine).toBe('core-bounded');
    expect(r.answer).toBe('兜底回答');
    expect(r.notice).toMatch(/Hermes 这一轮没能启动.*spawn hermes\.exe ENOENT/);
  });
});

describe('错误说人话', () => {
  it.each([
    ['API 错误 429: {"error":{"message":"Concurrency limit exceeded"}}', /同时处理的请求数到上限/],
    ['TUI gateway 进程无响应（超过 60s 静默无输出），已安全中止', /太久没有回应/],
    ['API 错误 401: invalid api key', /Key 无效/],
    ['API 错误 502: <!DOCTYPE html>', /上游暂时出错/],
  ])('%s', (raw, expected) => {
    expect(explainModelFailure(raw)).toMatch(expected);
    expect(explainModelFailure(raw)).toMatch(/原始错误：/);
  });

  it('认不出的错误原样给出（截断），不瞎猜', () => {
    expect(explainModelFailure('奇怪的错误')).toBe('奇怪的错误');
  });
});

describe('后台任务给聊天让路', () => {
  it('让路期间不开新任务；释放后继续', async () => {
    const q = new JobQueue(db, { warn: () => undefined, info: () => undefined });
    const ran: string[] = [];
    q.register('demo', async (job) => {
      ran.push(job.id);
    });
    const release = q.hold();
    const job = q.enqueue('demo', {});
    q.kick();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual([job.id]);
  });

  it('被打断的任务回到排队，不计失败、不占重试次数', async () => {
    const q = new JobQueue(db, { warn: () => undefined, info: () => undefined });
    q.register('demo', async () => {
      const err = new Error('让路') as Error & { jobPreempted: boolean };
      err.jobPreempted = true;
      throw err;
    });
    const job = q.enqueue('demo', {});
    q.kick();
    await new Promise((r) => setTimeout(r, 50));
    const row = db.prepare('SELECT status, retry_count, error FROM jobs WHERE id = ?').get(job.id);
    expect(row).toMatchObject({ status: 'queued', retry_count: 0, error: null });
  });
});

describe('Hermes 自己报的失败原因不丢', () => {
  const prevExe = process.env.IXAEON_HERMES_EXE;
  afterEach(() => {
    if (prevExe === undefined) delete process.env.IXAEON_HERMES_EXE;
    else process.env.IXAEON_HERMES_EXE = prevExe;
  });

  it('回合里 Hermes 报错（如网关 429）：不论适配器是抛错还是返回失败，用户都拿到带原话的说明', async () => {
    const exe = join(dir, 'hermes.exe');
    writeFileSync(exe, 'fake');
    process.env.IXAEON_HERMES_EXE = exe;
    const hostIn = new PassThrough();
    const hostOut = new PassThrough();
    const outbound: string[] = [];
    hostOut.on('data', (c: Buffer | string) => outbound.push(String(c)));
    const transport: TuiTransport = {
      rpc: new JsonRpcStdio(hostIn, hostOut),
      kill() {
        hostIn.end();
        hostOut.end();
      },
    };
    const broker = new CoreToolBroker(
      db,
      new ItemService(db),
      new SearchService(db),
      new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
      new ProjectService(db),
    );
    const adapter = new HermesRuntimeAdapter(broker, () => transport);
    const provider = new FakeProvider('core-fallback-model');
    const session = new AgentSession(db, adapter, broker, provider);
    const started = session.run({ goal: '在吗', projectId: null });
    const waitFor = async (method: string) => {
      for (let i = 0; i < 200; i++) {
        for (const line of outbound.join('').split('\n').filter(Boolean)) {
          const m = JSON.parse(line) as { id?: number; method?: string };
          if (m.method === method) return m;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`未等到 ${method}`);
    };
    const create = await waitFor('session.create');
    hostIn.write(
      JSON.stringify({ jsonrpc: '2.0', id: create.id, result: { session_id: 's1' } }) + '\n',
    );
    const submit = await waitFor('prompt.submit');
    hostIn.write(JSON.stringify({ jsonrpc: '2.0', id: submit.id, result: { ok: true } }) + '\n');
    hostIn.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.complete',
          session_id: 's1',
          payload: {
            status: 'error',
            error: 'API 错误 429: Concurrency limit exceeded for account',
          },
        },
      }) + '\n',
    );
    await expect(started).rejects.toThrow(
      /这一轮没答完：模型网关同时处理的请求数到上限了.*Concurrency limit exceeded/,
    );
    expect(provider.structuredCalls).toHaveLength(0); // 没有换 Core 重跑
    adapter.disposeAll();
  });
});
