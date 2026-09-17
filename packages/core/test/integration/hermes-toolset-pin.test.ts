/**
 * Hermes 工具集钉定（2026-09-17 真机问题的回归）。
 *
 * 真机记录：IXAEON 聊天时模型执行了 search_files，列出 Hermes 目录下 51 个文件，
 * 而 Core 账本记的是 skipped / tool_not_in_allowed_tools。原因是 TUI gateway 没有
 * tool.respond，Hermes 自跑原生工具，Core 的 allowedTools 拦不住；不钉工具集时
 * tui 会话拿到的是 hermes-cli 全套（含 terminal / file）。
 *
 * 下面的「真实解析」用例直接调用本机 Hermes 的 _load_enabled_toolsets，
 * 不发起会话、不调模型、不花钱；每个用例用临时 HERMES_HOME，只写 mcp_servers，
 * 不碰用户真实配置。本机未装 Hermes 时跳过。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  AgentSession,
  CodingOrchestrator,
  CoreToolBroker,
  FakeCodingExecutor,
  HERMES_TUI_TOOLSETS,
  HermesRuntimeAdapter,
  ItemService,
  ProjectService,
  SearchService,
  hermesSpawnEnv,
  locateHermes,
  migrate,
  openDatabase,
} from '../../src/index.js';

describe('Hermes 工具集钉定：启动环境', () => {
  it('每次启动都带上 web,ixaeon，不依赖外部环境', () => {
    const env = hermesSpawnEnv({
      found: true,
      exe: 'python.exe',
      cwd: 'repo',
      home: 'home',
      reason: 'test',
    });
    expect(env.HERMES_TUI_TOOLSETS).toBe('web,ixaeon');
    expect(HERMES_TUI_TOOLSETS).toBe('web,ixaeon');
  });

  it('钉定值不含本机文件、终端、代码执行与 Hermes 自带记忆', () => {
    const entries = HERMES_TUI_TOOLSETS.split(',');
    for (const risky of ['terminal', 'file', 'code_execution', 'computer_use', 'memory']) {
      expect(entries).not.toContain(risky);
    }
  });
});

const locator = locateHermes();
const canResolve = locator.found && locator.exe !== null && locator.cwd !== null;
const homes: string[] = [];

/** 在临时 HERMES_HOME 里跑 Hermes 自己的工具集解析；null 表示「全部工具集」。 */
function resolveToolsets(pin: string, mcpServers: string | null): string[] | null {
  const home = mkdtempSync(join(tmpdir(), 'ixaeon-hermes-pin-'));
  homes.push(home);
  if (mcpServers !== null) writeFileSync(join(home, 'config.yaml'), mcpServers, 'utf8');
  const script = [
    'import json',
    'from tui_gateway.server import _load_enabled_toolsets',
    "print('@@' + json.dumps(_load_enabled_toolsets('tui')))",
  ].join('\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: home,
    PYTHONPATH: locator.cwd!,
    PYTHONIOENCODING: 'utf-8',
  };
  if (pin === '') delete env.HERMES_TUI_TOOLSETS;
  else env.HERMES_TUI_TOOLSETS = pin;
  const r = spawnSync(locator.exe!, ['-c', script], {
    cwd: locator.cwd!,
    env,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  // tui_gateway 导入时会把 stdout 让给 JSON-RPC 协议、print 落到 stderr，两边都找。
  const line = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    .split(/\r?\n/)
    .find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`解析失败（退出码 ${r.status}）：${r.stderr}`);
  return JSON.parse(line.slice(2)) as string[] | null;
}

const bridge = (enabled: boolean) =>
  `mcp_servers:\n  ixaeon:\n    command: node\n    args: ["x.js"]\n    enabled: ${enabled}\n`;

describe.skipIf(!canResolve)('Hermes 工具集钉定：本机 Hermes 真实解析', () => {
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  it('记忆桥未配置：只有 web', () => {
    expect(resolveToolsets(HERMES_TUI_TOOLSETS, null)).toEqual(['web']);
  }, 120_000);

  it('记忆桥开启：web + ixaeon', () => {
    expect(resolveToolsets(HERMES_TUI_TOOLSETS, bridge(true))).toEqual(['web', 'ixaeon']);
  }, 120_000);

  it('记忆桥 enabled:false：只有 web', () => {
    expect(resolveToolsets(HERMES_TUI_TOOLSETS, bridge(false))).toEqual(['web']);
  }, 120_000);

  it('对照：不钉时是全套，含终端与本机文件（今天真机的状态）', () => {
    const all = resolveToolsets('', null);
    expect(all).not.toBeNull();
    expect(all).toEqual(expect.arrayContaining(['terminal', 'file', 'code_execution']));
  }, 120_000);

  it('对照：只钉 ixaeon 且桥未配置时退回全套——所以必须有 web 作锚', () => {
    const fallback = resolveToolsets('ixaeon', null);
    expect(fallback).not.toBeNull();
    expect(fallback).toEqual(expect.arrayContaining(['terminal', 'file']));
  }, 120_000);
});

describe('记忆路由约定：只在记忆桥接上时发给模型', () => {
  // 上面的真实解析说明：记忆桥没接上时，聊天里的 Hermes 既没有 record_observation，
  // 也没有自带 memory。这时还让模型「调用 record_observation」，只会让它每一轮
  // 都去找一个不存在的工具（首次真机那轮就空转了几次工具调用）。
  async function dispatchedGoal(memoryBridge?: boolean): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'ixaeon-route-'));
    const db = openDatabase(join(dir, 'ixaeon.db'));
    try {
      migrate(db);
      const broker = new CoreToolBroker(
        db,
        new ItemService(db),
        new SearchService(db),
        new CodingOrchestrator(db, new FakeCodingExecutor(), dir),
        new ProjectService(db),
      );
      const adapter = new HermesRuntimeAdapter(broker);
      vi.spyOn(adapter, 'probe').mockReturnValue({
        locator: { found: true, exe: 'hermes.exe', cwd: null, home: null, reason: 'test' },
        engine: 'hermes',
        session: true,
        stop: true,
        toolAllowlist: false,
        usage: false,
        resume: true,
        streaming: true,
        probedAt: new Date().toISOString(),
      });
      const start = vi.spyOn(adapter, 'start').mockResolvedValue({
        events: [],
        answer: '记下了',
        status: 'terminal',
        modelName: 'fake',
        providerName: 'fake',
        sessionId: 's-route',
      });
      const session = new AgentSession(
        db,
        adapter,
        broker,
        null,
        memoryBridge === undefined ? {} : { memoryBridge },
      );
      await session.run({ goal: '记住：我周三下午去看牙', projectId: null });
      expect(start).toHaveBeenCalledTimes(1);
      return start.mock.calls[0]![0].goal;
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('默认（记忆桥未接）：不让模型调 record_observation', async () => {
    const goal = await dispatchedGoal();
    expect(goal).toContain('记住：我周三下午去看牙');
    expect(goal).not.toContain('record_observation');
  });

  it('记忆桥接上后：附带约定，引导写入 IXAEON 而不是 Hermes 自带记忆', async () => {
    expect(await dispatchedGoal(true)).toContain('record_observation');
  });
});
