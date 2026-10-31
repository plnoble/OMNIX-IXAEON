/**
 * K10a 验收（第一支：核心读取 + IPC；规格 docs/委派/K10a-调度器面板.md，B 档本周例外）。
 *
 * 条件 1：合成 relay 目录（开发 argv 带 --patch、整合方没有 --model、review 没设）与合成补丁
 *          （providers 下 3 个网关共 5 个模型；开头注释表故意只列 1 个组合；每个网关里有
 *          apiKeyEnv: SECRET-XYZ、baseURL: https://gw.example.invalid）
 *          → 开发 = 当前组合、选项正好 5 个（按网关）；整合方 = 默认；审查 = 跟 Codex 自己的设置；
 *          JSON 里找不到 SECRET-XYZ、gw.example.invalid。
 * 条件 5：argv 里没有 --patch 的开发角色 → configured: false、note 有说明、不抛错。
 *
 * 替补两行没配时写「没配」也在这一支测。改文件（条件 2/3/4）在 K10b。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRelayModels } from '@ixaeon/core';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-k10a-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

const PATCH = `# 可选组合（手抄的，会过时；故意只列一个不在 providers 里的组合）
#   provider: old-only    model: stale-model

- id: sandbox-policy
  config:
    mode: danger-full-access

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      gw-a:
        apiKeyEnv: SECRET-XYZ
        api: openai-completions
        baseURL: https://gw.example.invalid
        models:
          - id: model-a1
            name: model-a1
          - id: model-a2
            name: model-a2
      gw-b:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: model-b1
            name: model-b1
      magpie:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: local-a
            name: local-a
          - id: local-b
            name: local-b

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: gw-b
    model: model-b1
`;

const ALL_OPTIONS = [
  'gw-a / model-a1',
  'gw-a / model-a2',
  'gw-b / model-b1',
  'magpie / local-a',
  'magpie / local-b',
];

function makeRelay(developerArgv?: unknown[]): { dir: string; patch: string } {
  const dir = tempDir();
  const patch = join(dir, 'relay.patch.yml');
  writeFileSync(patch, PATCH, 'utf8');
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify(
      {
        roles: {
          developer: {
            argv: developerArgv ?? [
              'node',
              'dsh.mjs',
              '--profile',
              'headless',
              '--patch',
              patch,
              '--json',
              '{prompt_file}',
            ],
            cwd: 'C:\\work',
          },
          integrator: {
            argv: ['claude.exe', '--restricted', '--tools', 'PowerShell', '-p', '{prompt_file}'],
            cwd: 'C:\\integrate',
          },
        },
        idleSeconds: 60,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { dir, patch };
}

function rowOf(models: ReturnType<typeof readRelayModels>, role: string) {
  const row = models.roles.find((r) => r.role === role);
  expect(row, `缺少角色 ${role}`).toBeTruthy();
  return row!;
}

describe('条件 1：读出现在用的模型与全部「网关 / 模型」', () => {
  it('开发当前组合、5 个选项（按网关，不受注释表影响）；整合方默认；审查跟 Codex；密钥与网关地址不出现', () => {
    const { dir, patch } = makeRelay();
    const models = readRelayModels({ relayDir: dir });

    const developer = rowOf(models, 'developer');
    expect(developer.agent).toBe('dsh');
    expect(developer.current).toBe('gw-b / model-b1');
    expect(developer.options).toEqual(ALL_OPTIONS);
    expect(developer.configured).toBe(true);

    const integrator = rowOf(models, 'integrator');
    expect(integrator.current).toBe('默认');
    expect(integrator.options).toEqual(['默认', 'opus', 'sonnet', 'haiku']);
    expect(integrator.configured).toBe(true);

    expect(rowOf(models, 'reviewer').current).toBe('跟 Codex 自己的设置');

    const text = JSON.stringify(models);
    expect(text).not.toContain('SECRET-XYZ');
    expect(text).not.toContain('gw.example.invalid');
    expect(text).not.toContain('old-only');
    expect(text).not.toContain('stale-model');
    // 只读：读完补丁一个字节都没动。
    expect(readFileSync(patch, 'utf8')).toBe(PATCH);
  });
});

describe('条件 5：argv 里没有 --patch', () => {
  it('开发 configured: false、note 有说明、不抛错', () => {
    const { dir } = makeRelay([
      'node',
      'dsh.mjs',
      '--profile',
      'headless',
      '--json',
      '{prompt_file}',
    ]);
    const models = readRelayModels({ relayDir: dir });
    const developer = rowOf(models, 'developer');
    expect(developer.configured).toBe(false);
    expect(developer.current).toBeNull();
    expect(developer.note).toBeTruthy();
    expect(rowOf(models, 'integrator').current).toBe('默认');
  });
});

describe('替补两行没配', () => {
  it('替补审查、替补整合方 → configured: false，界面显示「没配」', () => {
    const { dir } = makeRelay();
    const models = readRelayModels({ relayDir: dir });
    expect(rowOf(models, 'reviewerSubstitute').configured).toBe(false);
    expect(rowOf(models, 'integratorSubstitute').configured).toBe(false);
    expect(rowOf(models, 'reviewerSubstitute').note).toBe('没配');
    expect(rowOf(models, 'integratorSubstitute').note).toBe('没配');
  });
});
