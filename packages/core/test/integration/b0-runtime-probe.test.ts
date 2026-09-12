import { describe, it, expect } from 'vitest';
import { HermesRuntimeAdapter } from '../../src/runtime/adapter.js';
import { CORE_TOOL_NAMES } from '../../src/runtime/broker.js';
import { ErrorCodes, IxaError } from '@ixaeon/contracts';

describe('B0 Hermes 探测不假装接通', () => {
  it('本机未装时能力全否，start 抛缺口', async () => {
    delete process.env.IXAEON_HERMES_EXE;
    const adapter = new HermesRuntimeAdapter();
    const caps = adapter.probe();
    expect(caps.engine).toBe('missing');
    expect(caps.session).toBe(false);
    await expect(
      adapter.start({
        runId: 'r1',
        goal: '读一条资料并搜索',
        contextRef: 'c1',
        allowedTools: [...CORE_TOOL_NAMES],
        permissionVersion: '1',
        budget: { maxToolCalls: 3, timeoutMs: 60_000 },
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND } satisfies Partial<IxaError>);
  });
});
