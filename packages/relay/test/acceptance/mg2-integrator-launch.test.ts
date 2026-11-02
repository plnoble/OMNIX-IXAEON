/**
 * MG2 验收（规格 docs/委派/MG2-角色走magpie轮动.md，B 档：本周例外，测试和实现一起在分支上）。
 *
 * 条件 2：整合方选 group/rot → 调度器起整合方（替身）时收到 `--model group/rot`，
 *          `ANTHROPIC_BASE_URL` 是 magpie 的地址、Key 是 magpie；选回「默认」→ 参数和环境变量
 *          和原来逐字一样（不带这几项）。
 *
 * 审查脚本那一半在 MG2b（`packages/relay/test/acceptance/mg2-codex-launch.test.ts`）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTurn, type RelayConfig, type RelayState, type Turn } from '../../src/index.js';

const dirs: string[] = [];
const savedEnv = {
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  NO_PROXY: process.env.NO_PROXY,
};
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ixaeon-mg2-integrator-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

const STATE: RelayState = { pausedUntil: {}, turns: 0 };

/** 替身：把收到的参数和环境变量写进标记文件。 */
const ROLE_STUB = `import { writeFileSync } from 'node:fs';
const marker = process.env.MG2_MARKER;
if (marker) writeFileSync(marker, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    base: process.env.ANTHROPIC_BASE_URL ?? null,
    token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    key: process.env.ANTHROPIC_API_KEY ?? null,
    noProxy: process.env.NO_PROXY ?? null,
  },
}), 'utf8');
console.log('RELAY-DONE MG2 待复审（整合方）');
`;

function setup(magpie: { model: string; url: string } | null): {
  marker: string;
  config: RelayConfig;
  dataDir: string;
} {
  const root = mkTmp();
  const cwd = join(root, 'cwd');
  const dataDir = join(root, 'relay');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const stub = join(root, 'stub-role.mjs');
  writeFileSync(stub, ROLE_STUB, 'utf8');
  const marker = join(root, 'marker.json');
  const integrator: RelayConfig['roles']['integrator'] = {
    argv: [process.execPath, stub, '{prompt_file}', '--mode', 'ok'],
    cwd,
    timeoutMinutes: 10,
    quotaPatterns: ['usage_limit_reached'],
    quotaPauseMinutes: 200,
    ...(magpie ? { magpieModel: magpie.model, magpieUrl: magpie.url } : {}),
  };
  const developer: RelayConfig['roles']['developer'] = {
    argv: [process.execPath, stub, '{prompt_file}', '--mode', 'ok'],
    cwd,
    timeoutMinutes: 10,
    quotaPatterns: [],
    quotaPauseMinutes: 200,
  };
  return { marker, config: { roles: { integrator, developer }, idleSeconds: 60 }, dataDir };
}

function clearAgentEnv(): void {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.NO_PROXY;
}

const turn: Turn = {
  role: 'integrator',
  kind: 'integrator-review',
  taskId: 'MG2',
  task: 'MG2 合成复审',
  status: '待复审（整合方）',
};

describe('条件 2：整合方起 Claude Code 时按 magpie 的接法带上', () => {
  it('选 group/rot → --model group/rot、ANTHROPIC_BASE_URL 和 Key magpie', async () => {
    clearAgentEnv();
    const base = 'http://127.0.0.1:4321';
    const { marker, config, dataDir } = setup({ model: 'group/rot', url: base });
    process.env.MG2_MARKER = marker;
    try {
      await runTurn(turn, config, STATE, { dataDir, turnNumber: 1 });
    } finally {
      delete process.env.MG2_MARKER;
    }
    const got = JSON.parse(readFileSync(marker, 'utf8')) as {
      argv: string[];
      env: { base: string | null; token: string | null; key: string | null; noProxy: string | null };
    };
    expect(got.argv.slice(-2)).toEqual(['--model', 'group/rot']);
    // 原来的参数还在、顺序不变（prompt_file 换成了真路径）。
    expect(got.argv.slice(1, 3)).toEqual(['--mode', 'ok']);
    expect(got.env.base).toBe(base);
    expect(got.env.token).toBe('magpie');
    // 用户自己的 Anthropic Key 不带到 magpie 上。
    expect(got.env.key).toBeNull();
    // 整合方复审补：本机地址不进代理（系统代理会拦住连 magpie 的请求）。
    expect(got.env.noProxy).toContain('127.0.0.1');
  });

  it('默认 → 参数和环境变量和原来逐字一样（没有 --model 和这几个环境变量）', async () => {
    clearAgentEnv();
    const { marker, config, dataDir } = setup(null);
    process.env.MG2_MARKER = marker;
    try {
      await runTurn(turn, config, STATE, { dataDir, turnNumber: 1 });
    } finally {
      delete process.env.MG2_MARKER;
    }
    const got = JSON.parse(readFileSync(marker, 'utf8')) as {
      argv: string[];
      env: { base: string | null; token: string | null; key: string | null; noProxy: string | null };
    };
    expect(got.argv).not.toContain('--model');
    expect(got.env).toEqual({ base: null, token: null, key: null, noProxy: null });
  });
});