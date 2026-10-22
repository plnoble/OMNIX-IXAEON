/**
 * L4 验收测试（三）：配置检查与配置样例（规格条件 4、5，对应契约第 3、4 条）。
 *
 * 逐条对应：
 * - 条件 4：开发的 `cwd` 是数据目录的上一层 → 拒绝、原因里写清是 `developer`；整合方的 `cwd` 就是数据目录 → 拒绝；
 *   都不包着 → 放行。
 * - 条件 5：`config.example.json` 是合法 JSON；没有「跳过所有权限」的开关；
 *   `developer.argv` 里有 `packages/relay/bin/dsh.mjs`、`--profile`、`headless`、`--json`、`{prompt_file}`。
 *
 * 数据目录一律用 `IXAEON_RELAY_DIR` 指到临时目录，不碰用户本机真的数据目录。
 */
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, FORBIDDEN_SWITCHES, type RelayConfig } from '../../src/index.js';

const dirs: string[] = [];
const mkTmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const role = (cwd: string) => ({
  argv: [process.execPath, '-e', 'process.exit(0)'],
  cwd,
  timeoutMinutes: 60,
  quotaPatterns: [],
  quotaPauseMinutes: 10,
});

/** 在给定的 IXAEON_RELAY_DIR 下跑一段检查，跑完把环境恢复。 */
const withRelayDir = <T>(relayDir: string, fn: () => T): T => {
  const old = process.env.IXAEON_RELAY_DIR;
  process.env.IXAEON_RELAY_DIR = relayDir;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.IXAEON_RELAY_DIR;
    else process.env.IXAEON_RELAY_DIR = old;
  }
};

describe('条件 4：cwd 不许把数据目录包在里面', () => {
  it('开发的 cwd 是数据目录的上一层 → 拒绝，原因里写清是 developer', () => {
    const parent = mkTmp('ixa-l4-parent-');
    const dataDir = join(parent, 'relay');
    mkdirSync(dataDir, { recursive: true });
    const config: RelayConfig = {
      roles: { integrator: role(mkTmp('ixa-l4-integ-')), developer: role(parent) },
      idleSeconds: 60,
    };
    const r = withRelayDir(dataDir, () => checkConfig(config));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('developer');
  });

  // 整合方补（2026-10-22）：数据目录在 cwd 下面好几层也算包着；Windows 上不分大小写
  it('开发的 cwd 是数据目录往上两层（写法大小写不同）→ 也拒绝', () => {
    const top = mkTmp('ixa-l4-top-');
    const dataDir = join(top, 'a', 'relay');
    mkdirSync(dataDir, { recursive: true });
    const devCwd = process.platform === 'win32' ? top.toUpperCase() : top;
    const config: RelayConfig = {
      roles: { integrator: role(mkTmp('ixa-l4-integ-')), developer: role(devCwd) },
      idleSeconds: 60,
    };
    const r = withRelayDir(dataDir, () => checkConfig(config));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('developer');
  });

  it('整合方的 cwd 就是数据目录 → 拒绝', () => {
    const dataDir = mkTmp('ixa-l4-data-');
    const config: RelayConfig = {
      roles: { integrator: role(dataDir), developer: role(mkTmp('ixa-l4-dev-')) },
      idleSeconds: 60,
    };
    const r = withRelayDir(dataDir, () => checkConfig(config));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('integrator');
  });

  it('都不包着数据目录 → 放行', () => {
    const dataDir = mkTmp('ixa-l4-data-');
    const config: RelayConfig = {
      roles: { integrator: role(mkTmp('ixa-l4-integ-')), developer: role(mkTmp('ixa-l4-dev-')) },
      idleSeconds: 60,
    };
    expect(withRelayDir(dataDir, () => checkConfig(config))).toEqual({ ok: true });
  });
});

describe('条件 5：配置样例', () => {
  const text = readFileSync(
    join(process.cwd(), 'packages', 'relay', 'config.example.json'),
    'utf8',
  );

  it('是合法 JSON，且没有「跳过所有权限」的开关', () => {
    expect(() => JSON.parse(text)).not.toThrow();
    for (const sw of FORBIDDEN_SWITCHES) {
      expect(text, `样例里不该有 ${sw}`).not.toContain(sw);
    }
  });

  it('developer.argv 用的是仓库里的启动器，带 --profile headless --json 和 {prompt_file}', () => {
    const config = JSON.parse(text) as RelayConfig;
    const argv = config.roles.developer.argv;
    expect(argv.some((a) => a.replaceAll('\\', '/').endsWith('packages/relay/bin/dsh.mjs'))).toBe(
      true,
    );
    expect(argv).toContain('--profile');
    expect(argv).toContain('headless');
    expect(argv).toContain('--json');
    expect(argv.some((a) => a.includes('{prompt_file}'))).toBe(true);
  });
});
