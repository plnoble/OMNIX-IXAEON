import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  JsonRpcStdio,
  TuiGatewaySession,
  locateHermes,
  hermesSpawnEnv,
  hermesGatewayArgs,
} from '../../src/index.js';

/**
 * R02 真机探针：锁定安装（官方安装器 -Tag v2026.9.11，专属目录 D:\Software\IXAEON\Hermes，
 * 不碰用户 ~/.hermes）。默认跳过；IXAEON_REAL_HERMES=1 且定位器找到专属安装才跑。
 * provider 已由用户于 2026-09-12 配置（custom → 用户自建 OpenAI 兼容网关）。
 * 本探针验证完整真实回合；无凭证时的诚实失败路径已在此前阶段验证并记录于
 * docs/dev-log-v03.md（2026-09-12）。
 */
const run = process.env.IXAEON_REAL_HERMES === '1';

describe.skipIf(!run)('R02 真 Hermes stdio 网关（锁定 v2026.9.11）', () => {
  it('gateway.ready → session.create 返回 session_id → session.close 收尾', async () => {
    const locator = locateHermes();
    expect(locator.found).toBe(true);
    expect(locator.cwd).toBeTruthy();

    const child = spawn(locator.exe!, hermesGatewayArgs(), {
      cwd: locator.cwd ?? undefined,
      env: { ...process.env, ...hermesSpawnEnv(locator) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const rpc = new JsonRpcStdio(child.stdout!, child.stdin!);
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等 gateway.ready 超时（60s）')), 60_000);
        rpc.on('notification', (method: string, params: unknown) => {
          const p = params as { type?: string } | undefined;
          if (method === 'event' && p?.type === 'gateway.ready') {
            clearTimeout(timer);
            resolve(p as Record<string, unknown>);
          }
        });
        rpc.on('close', () => {
          clearTimeout(timer);
          reject(new Error('网关进程提前退出'));
        });
      });
      expect(ready).toBeTruthy();

      const created = (await rpc.request('session.create', { cols: 80 }, 90_000)) as {
        session_id?: string;
      };
      expect(typeof created?.session_id).toBe('string');
      expect(created!.session_id!.length).toBeGreaterThan(0);

      rpc.notify('session.close', { session_id: created.session_id });
    } finally {
      child.kill();
    }
  }, 120_000);

  it('真模型整回合：prompt.submit → message.complete → 回答非空且记为 terminal', async () => {
    const locator = locateHermes();
    expect(locator.found).toBe(true);
    const transport = TuiGatewaySession.spawnProcess(locator.exe!, hermesGatewayArgs(), {
      cwd: locator.cwd,
      env: hermesSpawnEnv(locator),
    });
    const session = new TuiGatewaySession(transport, {
      runId: 'r02-real-model',
      goal: '只回答两个字：正常',
      contextRef: 'personal',
      allowedTools: [],
      permissionVersion: '1',
      budget: { maxToolCalls: 2, timeoutMs: 180_000 },
      idempotencyKey: 'r02-real-model',
    });
    const result = await session.run();
    expect(result.status).toBe('terminal');
    expect(result.answer.trim().length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.kind === 'terminal')).toBe(true);
    expect(
      result.events.some((e) => e.kind === 'text' && e.payload['phase'] === 'session.create'),
    ).toBe(true);
    transport.kill();
  }, 210_000);
});
