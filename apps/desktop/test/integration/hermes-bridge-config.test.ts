/**
 * 记忆桥（F1）写 Hermes 配置：用本机 Hermes 自己的写入器与加载器验证。
 *
 * 每个用例用临时 HERMES_HOME，绝不碰用户真实的 config.yaml。本机未装 Hermes 时跳过
 * 真实部分（纯函数部分照跑）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HERMES_TUI_TOOLSETS, locateHermes, type HermesLocator } from '@ixaeon/core';
import {
  bridgeBlockedReason,
  bridgeEntry,
  plainHttpGateways,
  writeHermesBridgeEntry,
} from '../../src/main/hermesBridge.js';

/** 仿真实配置：有注释、有网关、有自定义提供商——写入后这些都必须原样还在。 */
const SAMPLE_CONFIG = [
  '# 用户自己写的注释：不能被 IXAEON 弄丢',
  'model:',
  '  default: some-model',
  '  provider: custom',
  '  base_url: https://gateway.example.com/v1',
  'custom_providers:',
  '  - name: example',
  '    base_url: https://gateway.example.com/v1',
  '    model: some-model  # 行尾注释',
  '',
].join('\n');

describe('开启前的检查（纯函数）', () => {
  it('找出明文 HTTP 网关；本机回环不算', () => {
    expect(
      plainHttpGateways(
        [
          'base_url: http://203.0.113.10:3001/v1',
          '  base_url: "https://ok.example.com/v1"',
          '  base_url: http://127.0.0.1:8080/v1',
          '  base_url: http://localhost:11434',
        ].join('\n'),
      ),
    ).toEqual(['http://203.0.113.10:3001/v1']);
  });

  it('网关是明文时不让开，并说清原因', () => {
    const home = mkdtempSync(join(tmpdir(), 'ixaeon-bridge-guard-'));
    try {
      writeFileSync(join(home, 'config.yaml'), 'model:\n  base_url: http://203.0.113.10:3001/v1\n');
      const locator: HermesLocator = { found: true, exe: 'py', cwd: 'repo', home, reason: 't' };
      expect(bridgeBlockedReason(locator)).toMatch(/明文 HTTP.*203\.0\.113\.10/);
      writeFileSync(join(home, 'config.yaml'), 'model:\n  base_url: https://ok.example.com/v1\n');
      expect(bridgeBlockedReason(locator)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('令牌只以占位符出现在要写进 Hermes 配置的内容里', () => {
    const entry = bridgeEntry(process.execPath, true);
    expect(entry.env.IXAEON_HERMES_TOKEN).toBe('${IXAEON_HERMES_BRIDGE_TOKEN}');
    expect(entry.env.IXAEON_MCP_PROFILE).toBe('hermes');
    expect(JSON.stringify(entry)).not.toMatch(/[0-9a-f]{64}/);
  });
});

const real = locateHermes();
const canRun = real.found && real.exe !== null && real.cwd !== null;
const homes: string[] = [];
/** 构建好的 MCP 服务入口（verify 的 build 步骤产出）。 */
const MCP_DIST = join(process.cwd(), 'apps', 'mcp', 'dist', 'index.mjs');

function tempHome(): HermesLocator {
  const home = mkdtempSync(join(tmpdir(), 'ixaeon-bridge-hermes-'));
  homes.push(home);
  writeFileSync(join(home, 'config.yaml'), SAMPLE_CONFIG, 'utf8');
  return { ...real, home };
}

/** 用 Hermes 自己的加载器看它眼里的 mcp_servers.ixaeon 与聊天工具集。 */
function hermesSees(home: string, bridgeToken: string | null) {
  const script = [
    'import json',
    'from tools.mcp_tool_config import _load_mcp_config',
    'from tui_gateway.server import _load_enabled_toolsets',
    'servers = _load_mcp_config()',
    'ix = servers.get("ixaeon") or {}',
    'print("@@" + json.dumps({"token": (ix.get("env") or {}).get("IXAEON_HERMES_TOKEN"),',
    '  "enabled": ix.get("enabled"), "toolsets": _load_enabled_toolsets("tui")}))',
  ].join('\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: home,
    PYTHONPATH: real.cwd!,
    PYTHONIOENCODING: 'utf-8',
    HERMES_TUI_TOOLSETS,
  };
  delete env.IXAEON_HERMES_BRIDGE_TOKEN;
  if (bridgeToken) env.IXAEON_HERMES_BRIDGE_TOKEN = bridgeToken;
  const r = spawnSync(real.exe!, ['-c', script], { cwd: real.cwd!, env, encoding: 'utf8' });
  const all = `${r.stdout}\n${r.stderr}`;
  const m = /@@(\{.*\})/.exec(all);
  if (!m) throw new Error(`Hermes 没给出结果：${all.slice(-600)}`);
  return JSON.parse(m[1]!) as {
    token: string | null;
    enabled: boolean | null;
    toolsets: string[] | null;
  };
}

describe.skipIf(!canRun)('写 Hermes 配置（本机 Hermes 真实写入与加载）', () => {
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  it('开启：登记 ixaeon，原有注释与配置原样保留，令牌不落盘', async () => {
    const locator = tempHome();
    const backup = await writeHermesBridgeEntry(locator, bridgeEntry(process.execPath, true));
    const text = readFileSync(join(locator.home!, 'config.yaml'), 'utf8');
    expect(text).toContain('# 用户自己写的注释：不能被 IXAEON 弄丢');
    expect(text).toContain('# 行尾注释');
    expect(text).toContain('base_url: https://gateway.example.com/v1');
    expect(text).toContain('${IXAEON_HERMES_BRIDGE_TOKEN}');
    expect(readFileSync(backup, 'utf8')).toBe(SAMPLE_CONFIG);
  }, 120_000);

  it('Hermes 看到的：网关带着令牌时展开成真令牌、工具集里有 ixaeon；不带时占位符原样（连不上）', async () => {
    const locator = tempHome();
    await writeHermesBridgeEntry(locator, bridgeEntry(process.execPath, true));
    const on = hermesSees(locator.home!, 'tok-abc');
    expect(on.token).toBe('tok-abc');
    expect(on.toolsets).toEqual(['web', 'ixaeon']);
    const noToken = hermesSees(locator.home!, null);
    expect(noToken.token).toBe('${IXAEON_HERMES_BRIDGE_TOKEN}');
  }, 120_000);

  it('关闭：enabled 变 false，聊天工具集里不再有 ixaeon', async () => {
    const locator = tempHome();
    await writeHermesBridgeEntry(locator, bridgeEntry(process.execPath, true));
    await writeHermesBridgeEntry(locator, bridgeEntry(process.execPath, false));
    const off = hermesSees(locator.home!, 'tok-abc');
    expect(off.enabled).toBe(false);
    expect(off.toolsets).toEqual(['web']);
  }, 120_000);

  it.skipIf(!existsSync(MCP_DIST))(
    'Hermes 的 MCP 客户端真能拉起记忆桥服务：只看到三个工具，名字带 mcp__ixaeon__ 前缀',
    () => {
      const home = tempHome().home!;
      const spec = {
        command: process.execPath,
        args: [MCP_DIST],
        env: { IXAEON_MCP_PROFILE: 'hermes', IXAEON_HERMES_TOKEN: 'test-token' },
        enabled: true,
      };
      const script = [
        'import json, os, sys',
        'from tools.mcp_tool_discovery import register_mcp_servers',
        'names = register_mcp_servers({"ixaeon": json.loads(os.environ["IXAEON_TEST_SPEC"])})',
        'print("@@" + json.dumps(sorted(n for n in names if n.startswith("mcp__ixaeon__"))))',
        'sys.stdout.flush()',
        'os._exit(0)',
      ].join('\n');
      const r = spawnSync(real.exe!, ['-c', script], {
        cwd: real.cwd!,
        env: {
          ...process.env,
          HERMES_HOME: home,
          PYTHONPATH: real.cwd!,
          PYTHONIOENCODING: 'utf-8',
          IXAEON_TEST_SPEC: JSON.stringify(spec),
        },
        encoding: 'utf8',
        timeout: 90_000,
      });
      const m = /@@(\[.*\])/.exec(`${r.stdout}\n${r.stderr}`);
      expect(m, (r.stderr ?? '').slice(-800)).not.toBeNull();
      expect(JSON.parse(m![1]!)).toEqual([
        'mcp__ixaeon__get_evidence',
        'mcp__ixaeon__record_observation',
        'mcp__ixaeon__search_memory',
      ]);
    },
    120_000,
  );

  it('备份只留 IXAEON 自己的最近 5 份', async () => {
    const locator = tempHome();
    for (let i = 0; i < 7; i++) {
      await writeHermesBridgeEntry(locator, bridgeEntry(process.execPath, i % 2 === 0));
    }
    const backups = readdirSync(locator.home!).filter((f) =>
      f.startsWith('config.yaml.bak-ixaeon-'),
    );
    expect(backups.length).toBeLessThanOrEqual(5);
  }, 300_000);
});
