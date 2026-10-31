/**
 * K10a 验收（规格 docs/委派/K10a-调度器面板.md，B 档：本周例外，测试和实现一起在分支上）。
 *
 * 条件 1：合成 relay 目录（开发 argv 带 --patch、整合方没有 --model、review 没设）与合成补丁
 *          （providers 下 3 个网关共 5 个模型；开头注释表故意只列 1 个组合；每个网关里有
 *          apiKeyEnv: SECRET-XYZ、baseURL: https://gw.example.invalid）
 *          → 开发 = 当前组合、选项正好 5 个（按网关）；整合方 = 默认；审查 = 跟 Codex 自己的设置；
 *          JSON 里找不到 SECRET-XYZ、gw.example.invalid。
 * 条件 2：开发改成另一个组合 → 补丁除了那两行逐字节不变；同目录多一个 .bak- 备份，内容等于改之前。
 * 条件 3：整合方选 sonnet → argv 里有且只有一对 --model sonnet，其余参数顺序不变；
 *          再选默认 → 那一对去掉。
 * 条件 4：不在选项里的值、Codex 那行传 `gpt;rm -rf` → 拒绝（VALIDATION_FAILED），文件不动、没有备份。
 * 条件 5：argv 里没有 --patch 的开发角色 → configured: false、note 有说明、不抛错。
 *
 * 另外按「约束」补：报错里也不出现补丁里的密钥与网关地址。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRelayModels, setRelayModel } from '@ixaeon/core';

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

function makeRelay(opts: { developerArgv?: unknown[] } = {}): {
  dir: string;
  patch: string;
  config: string;
} {
  const dir = tempDir();
  const patch = join(dir, 'relay.patch.yml');
  writeFileSync(patch, PATCH, 'utf8');
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        roles: {
          developer: {
            argv: opts.developerArgv ?? [
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
  return { dir, patch, config };
}

function backups(patch: string): string[] {
  return readdirSync(join(patch, '..')).filter((f) => f.startsWith('relay.patch.yml.bak-'));
}

function rowOf(models: ReturnType<typeof readRelayModels>, role: string) {
  const row = models.roles.find((r) => r.role === role);
  expect(row, `缺少角色 ${role}`).toBeTruthy();
  return row!;
}

describe('条件 1：读出现在用的模型与全部「网关 / 模型」', () => {
  it('开发当前组合、5 个选项（按网关分组，不受注释表影响）；整合方默认；审查跟 Codex；密钥与网关地址不出现', () => {
    const { dir } = makeRelay();
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

    const reviewer = rowOf(models, 'reviewer');
    expect(reviewer.current).toBe('跟 Codex 自己的设置');

    const text = JSON.stringify(models);
    expect(text).not.toContain('SECRET-XYZ');
    expect(text).not.toContain('gw.example.invalid');
    expect(text).not.toContain('old-only');
    expect(text).not.toContain('stale-model');
  });
});

describe('条件 2：改开发只动默认模型那两行，先留备份', () => {
  it('补丁其余字节不变；备份内容等于改之前', () => {
    const { dir, patch } = makeRelay();
    const before = readFileSync(patch, 'utf8');

    setRelayModel({ relayDir: dir }, { role: 'developer', value: 'magpie / local-a' });

    const after = readFileSync(patch, 'utf8');
    const expected = before
      .replace('provider: gw-b', 'provider: magpie')
      .replace('model: model-b1', 'model: local-a');
    expect(after).toBe(expected);

    const files = backups(patch);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^relay\.patch\.yml\.bak-\d{8}-\d{6}$/);
    expect(readFileSync(join(dir, files[0]!), 'utf8')).toBe(before);

    const models = readRelayModels({ relayDir: dir });
    expect(rowOf(models, 'developer').current).toBe('magpie / local-a');
    expect(rowOf(models, 'developer').options).toEqual(ALL_OPTIONS);
  });
});

describe('条件 3：整合方 --model 的加减不扰动其他参数', () => {
  it('选 sonnet 有且只有一对 --model sonnet；选默认去掉；其余参数顺序不变', () => {
    const { dir, config } = makeRelay();
    const original = JSON.parse(readFileSync(config, 'utf8')) as {
      roles: { integrator: { argv: string[] } };
    };
    const originalArgv = [...original.roles.integrator.argv];

    setRelayModel({ relayDir: dir }, { role: 'integrator', value: 'sonnet' });
    let now = JSON.parse(readFileSync(config, 'utf8')) as {
      roles: { integrator: { argv: string[] } };
    };
    const sonnetAt = now.roles.integrator.argv.filter((a) => a === '--model');
    expect(sonnetAt).toHaveLength(1);
    expect(now.roles.integrator.argv[now.roles.integrator.argv.indexOf('--model') + 1]).toBe(
      'sonnet',
    );
    expect(now.roles.integrator.argv.filter((a) => a !== '--model' && a !== 'sonnet')).toEqual(
      originalArgv,
    );

    setRelayModel({ relayDir: dir }, { role: 'integrator', value: '默认' });
    now = JSON.parse(readFileSync(config, 'utf8')) as {
      roles: { integrator: { argv: string[] } };
    };
    expect(now.roles.integrator.argv).toEqual(originalArgv);
  });
});

describe('条件 4：不在选项里的值一律拒绝且文件不动', () => {
  it('开发传没登记的模型 → VALIDATION_FAILED、补丁不变、没有备份，报错不泄露补丁内容', () => {
    const { dir, patch } = makeRelay();
    const before = readFileSync(patch, 'utf8');
    let caught: unknown = null;
    try {
      setRelayModel({ relayDir: dir }, { role: 'developer', value: 'gw-a / model-nope' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('IXA0012');
    expect((caught as Error).message).not.toContain('SECRET-XYZ');
    expect((caught as Error).message).not.toContain('gw.example.invalid');
    expect(readFileSync(patch, 'utf8')).toBe(before);
    expect(backups(patch)).toHaveLength(0);
  });

  it('审查那行传 gpt;rm -rf → 拒绝、config 不变、没有备份', () => {
    const { dir, config } = makeRelay();
    const before = readFileSync(config, 'utf8');
    let caught: unknown = null;
    try {
      setRelayModel({ relayDir: dir }, { role: 'reviewer', value: 'gpt;rm -rf' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: string }).code).toBe('IXA0012');
    expect(readFileSync(config, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toHaveLength(0);
  });
});

describe('条件 5：argv 里没有 --patch', () => {
  it('开发 configured: false、note 有说明、不抛错', () => {
    const { dir } = makeRelay({
      developerArgv: ['node', 'dsh.mjs', '--profile', 'headless', '--json', '{prompt_file}'],
    });
    const models = readRelayModels({ relayDir: dir });
    const developer = rowOf(models, 'developer');
    expect(developer.configured).toBe(false);
    expect(developer.current).toBeNull();
    expect(developer.note).toBeTruthy();
    // 其他角色照常读。
    expect(rowOf(models, 'integrator').current).toBe('默认');
  });
});

describe('没配 / 没配替补', () => {
  it('替补审查、替补整合方没配 → configured: false，界面显示「没配」', () => {
    const { dir } = makeRelay();
    const models = readRelayModels({ relayDir: dir });
    expect(rowOf(models, 'reviewerSubstitute').configured).toBe(false);
    expect(rowOf(models, 'integratorSubstitute').configured).toBe(false);
    expect(rowOf(models, 'reviewerSubstitute').note).toBe('没配');
    expect(rowOf(models, 'integratorSubstitute').note).toBe('没配');
  });
});

describe('审查那一行写 review.codexModel', () => {
  it('设 demo-model 后读回来是 demo-model；空串回到「跟 Codex 自己的设置」', () => {
    const { dir, config } = makeRelay();
    setRelayModel({ relayDir: dir }, { role: 'reviewer', value: 'demo-model' });
    expect(JSON.parse(readFileSync(config, 'utf8')).review.codexModel).toBe('demo-model');
    expect(rowOf(readRelayModels({ relayDir: dir }), 'reviewer').current).toBe('demo-model');

    setRelayModel({ relayDir: dir }, { role: 'reviewer', value: '' });
    expect(JSON.parse(readFileSync(config, 'utf8')).review.codexModel).toBeUndefined();
    expect(rowOf(readRelayModels({ relayDir: dir }), 'reviewer').current).toBe(
      '跟 Codex 自己的设置',
    );
  });
});
