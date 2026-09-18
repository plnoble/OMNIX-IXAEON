import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErrorCodes,
  HERMES_BRIDGE_MCP_TOKEN_ENV,
  HERMES_BRIDGE_SERVER,
  HERMES_BRIDGE_TOKEN_ENV,
  IxaError,
} from '@ixaeon/contracts';
import type { HermesLocator } from '@ixaeon/core';
import { resolveMcpCommand } from './mcpSnippet.js';

/**
 * 记忆桥（三周任务单 F1）：在 Hermes 的 config.yaml 里登记 / 停用 mcp_servers.ixaeon。
 *
 * 写配置用 Hermes 自己的 utils.atomic_roundtrip_yaml_update（经它的 Python 调用）：
 * 保留用户的注释、顺序、引号，临时文件 + 原子替换——不自己拼 YAML，写坏了
 * 用户的 Hermes 会整个起不来。写之前先备份。
 *
 * 令牌不写进 config.yaml：env 里写 ${IXAEON_HERMES_BRIDGE_TOKEN}，Hermes 加载
 * mcp_servers 时从网关进程环境展开；IXAEON 只在记忆桥开着时把它传给网关。
 */

export interface HermesBridgeEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

/** 由本机 IXAEON 的启动方式推出 Hermes 该怎么拉起 MCP 服务（与 Codex 配置片段同源）。 */
export function bridgeEntry(execPath: string, enabled: boolean): HermesBridgeEntry {
  const { command, mcpEntry } = resolveMcpCommand(execPath);
  return {
    command,
    args: [mcpEntry],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      IXAEON_MCP_PROFILE: 'hermes',
      [HERMES_BRIDGE_MCP_TOKEN_ENV]: `\${${HERMES_BRIDGE_TOKEN_ENV}}`,
    },
    enabled,
  };
}

/**
 * Hermes 的模型网关里还在用明文 HTTP 的地址（本机回环除外）。
 * 记忆桥开着时，查到的记忆会随对话发给模型网关——明文就等于把记忆公开在路上。
 */
export function plainHttpGateways(configYaml: string): string[] {
  const found = new Set<string>();
  for (const m of configYaml.matchAll(/^\s*base_url:\s*["']?([^"'\s#]+)/gm)) {
    const url = m[1]!;
    if (!/^http:\/\//i.test(url)) continue;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')
      continue;
    found.add(url);
  }
  return [...found];
}

/** 开启记忆桥前的检查；返回 null 表示可以开，否则是给用户看的原因。 */
export function bridgeBlockedReason(locator: HermesLocator): string | null {
  if (!locator.found || !locator.exe || !locator.cwd || !locator.home) {
    return '没有找到 IXAEON 专属的 Hermes，记忆桥无从接起。';
  }
  const cfg = join(locator.home, 'config.yaml');
  if (!existsSync(cfg)) return `Hermes 配置文件不存在：${cfg}`;
  const plain = plainHttpGateways(readFileSync(cfg, 'utf8'));
  if (plain.length > 0) {
    return (
      `Hermes 的模型网关还是明文 HTTP（${plain.join('、')}）。开启后查到的记忆会随对话` +
      '明文发出去，先把网关换成 HTTPS。'
    );
  }
  return null;
}

const BACKUP_PREFIX = 'config.yaml.bak-ixaeon-';

/** 备份 config.yaml，只保留 IXAEON 自己留下的最近 5 份。返回备份路径。 */
function backupHermesConfig(home: string): string {
  const cfg = join(home, 'config.yaml');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(home, `${BACKUP_PREFIX}${stamp}`);
  copyFileSync(cfg, backup);
  const ours = readdirSync(home)
    .filter((f) => f.startsWith(BACKUP_PREFIX))
    .sort();
  for (const old of ours.slice(0, Math.max(0, ours.length - 5))) {
    try {
      unlinkSync(join(home, old));
    } catch {
      /* 删不掉旧备份不影响本次写入 */
    }
  }
  return backup;
}

const WRITE_SCRIPT = [
  'import json, os, sys',
  'from pathlib import Path',
  'import yaml',
  'from utils import atomic_roundtrip_yaml_update',
  'cfg = Path(os.environ["HERMES_HOME"]) / "config.yaml"',
  'spec = json.loads(sys.stdin.read())',
  `atomic_roundtrip_yaml_update(cfg, "mcp_servers.${HERMES_BRIDGE_SERVER}", spec)`,
  'data = yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}',
  `entry = (data.get("mcp_servers") or {}).get("${HERMES_BRIDGE_SERVER}") or {}`,
  'env = entry.get("env") or {}',
  'ok = (entry.get("enabled") is spec["enabled"] and entry.get("command") == spec["command"]',
  '      and env == spec["env"])',
  'print("@@" + json.dumps({"ok": bool(ok)}))',
].join('\n');

/**
 * 在 Hermes 的 config.yaml 里写入 mcp_servers.ixaeon（开或关）。先备份；写完用
 * PyYAML 重新读一遍核对，对不上就用备份还原并报错。返回备份路径。
 */
export async function writeHermesBridgeEntry(
  locator: HermesLocator,
  entry: HermesBridgeEntry,
): Promise<string> {
  if (!locator.exe || !locator.cwd || !locator.home) {
    throw new IxaError(ErrorCodes.NOT_FOUND, '没有找到 IXAEON 专属的 Hermes');
  }
  const home = locator.home;
  const backup = backupHermesConfig(home);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(locator.exe!, ['-c', WRITE_SCRIPT], {
      cwd: locator.cwd!,
      env: {
        ...process.env,
        HERMES_HOME: home,
        PYTHONPATH: locator.cwd!,
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('写 Hermes 配置超时（30 秒）'));
    }, 30_000);
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Hermes 会把部分 stdout 重定向到 stderr（见 hermes-toolset-pin 测试），两边都看
      const all = `${out}\n${err}`;
      if (code === 0 || all.includes('@@')) resolve(all);
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `退出码 ${code}`));
    });
    child.stdin.end(JSON.stringify(entry));
  }).catch((e: unknown) => {
    copyFileSync(backup, join(home, 'config.yaml'));
    throw new IxaError(
      ErrorCodes.UNKNOWN,
      `写 Hermes 配置失败，已用备份还原：${e instanceof Error ? e.message : String(e)}`,
    );
  });
  const verdict = /@@(\{.*\})/.exec(output)?.[1];
  const ok = verdict ? (JSON.parse(verdict) as { ok: boolean }).ok : false;
  if (!ok) {
    copyFileSync(backup, join(home, 'config.yaml'));
    throw new IxaError(ErrorCodes.UNKNOWN, '写入后核对 Hermes 配置不一致，已用备份还原');
  }
  return backup;
}
