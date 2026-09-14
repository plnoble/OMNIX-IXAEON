import { describe, it, expect, afterEach } from 'vitest';
import { HermesRuntimeAdapter } from '../../src/runtime/adapter.js';
import { CORE_TOOL_NAMES } from '../../src/runtime/broker.js';
import { ErrorCodes, type IxaError } from '@ixaeon/contracts';

// 「本机未装」必须构造确定状态：清空全部定位变量（本机真装 Hermes 时
// 安装器写入用户级的 HERMES_HOME 存在，会让离线测试意外启动真引擎；
// 与 2026-09-13 独立审核的处理一致）。
const previousExe = process.env.IXAEON_HERMES_EXE;
const previousHome = process.env.IXAEON_HERMES_HOME;
const previousInstallerHome = process.env.HERMES_HOME;

afterEach(() => {
  if (previousExe === undefined) delete process.env.IXAEON_HERMES_EXE;
  else process.env.IXAEON_HERMES_EXE = previousExe;
  if (previousHome === undefined) delete process.env.IXAEON_HERMES_HOME;
  else process.env.IXAEON_HERMES_HOME = previousHome;
  if (previousInstallerHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previousInstallerHome;
});

describe('B0 Hermes 探测不假装接通', () => {
  it('本机未装时能力全否，start 抛缺口', async () => {
    delete process.env.IXAEON_HERMES_EXE;
    delete process.env.IXAEON_HERMES_HOME;
    delete process.env.HERMES_HOME;
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
