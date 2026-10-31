/**
 * L11 验收条件 5：配置。
 * - `checkConfig`：`lanes` 不是 1 或 2 不过；`lanes: 2` 时两个角色都要有 `gitIdentity`、
 *   两个 name 不一样，否则不过；`lanes` 不写或写 1，没有 gitIdentity 也照常过。
 * - `relay init` 生成的配置：`lanes: 1`、开发 `dev/dev@ixaeon.local`、整合方
 *   `relay-integrator/integrator@ixaeon.local`；`config.example.json` 同。
 *
 * 先测试后实现（B 档）：`lanes`/`gitIdentity` 的校验还没写，相关条目现在是红的。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig } from '../../src/config.js';
import type { RelayConfig } from '../../src/types.js';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 最小可用配置（照 relay init 生成的形状），角色 argv 随便给——checkConfig 不看存在性。 */
function config(over: {
  lanes?: 1 | 2;
  devIdentity?: { name: string; email: string };
  integIdentity?: { name: string; email: string };
}): RelayConfig {
  // cwd 要真实存在（checkConfig 会查）：用临时目录
  const intCwd = join(
    tmpdir(),
    `ixa-l11-cfg-i-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const devCwd = join(
    tmpdir(),
    `ixa-l11-cfg-d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  mkdirSync(intCwd, { recursive: true });
  mkdirSync(devCwd, { recursive: true });
  dirs.push(intCwd, devCwd);
  return {
    roles: {
      integrator: {
        argv: ['node', '-e', ''],
        cwd: intCwd,
        timeoutMinutes: 5,
        quotaPatterns: [],
        quotaPauseMinutes: 30,
        ...(over.integIdentity ? { gitIdentity: over.integIdentity } : {}),
      },
      developer: {
        argv: ['node', '-e', ''],
        cwd: devCwd,
        timeoutMinutes: 5,
        quotaPatterns: [],
        quotaPauseMinutes: 30,
        ...(over.devIdentity ? { gitIdentity: over.devIdentity } : {}),
      },
    },
    idleSeconds: 1,
    ...(over.lanes !== undefined ? { lanes: over.lanes } : {}),
  } as unknown as RelayConfig;
}

describe('条件 5：checkConfig 的 lanes 与 gitIdentity', () => {
  it('lanes 不写或写 1：没有 gitIdentity 也照常过', () => {
    expect(checkConfig(config({}))).toEqual({ ok: true });
    expect(checkConfig(config({ lanes: 1 }))).toEqual({ ok: true });
  });

  it('lanes: 2 且两个角色的 gitIdentity 齐全、name 不一样：过', () => {
    expect(
      checkConfig(
        config({
          lanes: 2,
          devIdentity: { name: 'dev', email: 'dev@ixaeon.local' },
          integIdentity: { name: 'relay-integrator', email: 'integrator@ixaeon.local' },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('lanes: 3 不过；lanes: 2 缺一个 gitIdentity 不过；两个 name 一样不过', () => {
    expect(checkConfig(config({ lanes: 3 as unknown as 2 })).ok).toBe(false);
    expect(
      checkConfig(config({ lanes: 2, devIdentity: { name: 'dev', email: 'dev@ixaeon.local' } })).ok,
    ).toBe(false);
    expect(
      checkConfig(
        config({
          lanes: 2,
          devIdentity: { name: 'same', email: 'a@ixaeon.local' },
          integIdentity: { name: 'same', email: 'b@ixaeon.local' },
        }),
      ).ok,
    ).toBe(false);
  });

  it('relay init 生成的配置照契约第 1 条；config.example.json 同', () => {
    const dataDir = temp('ixa-l11-init-');
    const REPO = process.cwd();
    const pnpm = join(REPO, 'node_modules', '.pnpm');
    const jitiDir = readdirSafe(pnpm).find((d) => d.startsWith('jiti@'));
    const cli = jitiDir
      ? join(pnpm, jitiDir, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs')
      : join(REPO, 'node_modules', 'jiti', 'lib', 'jiti-cli.mjs');
    const r = spawnSync(
      process.execPath,
      [cli, join(REPO, 'packages', 'relay', 'bin', 'relay-main.ts'), 'init'],
      {
        cwd: REPO,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
        env: { ...process.env, IXAEON_RELAY_DIR: dataDir },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const generated = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as RelayConfig;
    expect(generated.lanes).toBe(1);
    expect(generated.roles.developer.gitIdentity).toEqual({
      name: 'dev',
      email: 'dev@ixaeon.local',
    });
    expect(generated.roles.integrator.gitIdentity).toEqual({
      name: 'relay-integrator',
      email: 'integrator@ixaeon.local',
    });
    // config.example.json 同一份字段
    const examplePath = join(REPO, 'packages', 'relay', 'config.example.json');
    expect(existsSync(examplePath)).toBe(true);
    const example = JSON.parse(readFileSync(examplePath, 'utf8')) as RelayConfig;
    expect(example.lanes).toBe(1);
    expect(example.roles.developer.gitIdentity).toEqual({
      name: 'dev',
      email: 'dev@ixaeon.local',
    });
    expect(example.roles.integrator.gitIdentity).toEqual({
      name: 'relay-integrator',
      email: 'integrator@ixaeon.local',
    });
  }, 180_000);
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
