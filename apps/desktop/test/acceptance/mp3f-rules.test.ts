/**
 * MP3f 验收条件 16、17：审查/整合不能跟开发选成同一个模型（`setRelayModel` 拒绝，
 * 抛 VALIDATION_FAILED），用合成 relay 目录；被拒时 config 与补丁一个字节不变、不留 .bak。
 *
 * 16：开发「某网关 / gpt-x」时把审查选成 gpt-x 被拒（提示有「审查」「开发」和 gpt-x）；
 *     反过来先有审查 gpt-x、再把开发选成该模型也被拒。
 * 17：开发「… / claude-opus-x」时整合选 opus 被拒、sonnet 可以；一边是「默认」或
 *     「跟 Codex 自己的设置」不拦；开发是分组（group/ 开头）不拦，且开发那行 note 有提醒。
 *
 * 现在没有这两道拦，本文件应当红（该拒的没拒）。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRelayModels, setRelayModel } from '@ixaeon/core';

const PATCH = `- id: sandbox-policy
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
          - id: gpt-x
            name: gpt-x
      gw-c:
        apiKeyEnv: SECRET-XYZ
        api: openai-completions
        baseURL: https://gw.example.invalid
        models:
          - id: claude-opus-x
            name: claude-opus-x
      magpie:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: local-a
            name: local-a

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: gw-a
    model: model-placeholder
`;

let dir: string;
let configPath: string;
let patchPath: string;

const savedDshHome = process.env['DSH_HOME'];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-mp3f-'));
  process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'ixaeon-mp3f-dsh-'));
  patchPath = join(dir, 'relay.patch.yml');
  writeFileSync(patchPath, PATCH, 'utf8');
  configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        roles: {
          developer: {
            argv: ['node', 'dsh.mjs', '--patch', patchPath, '--json', '{prompt_file}'],
            cwd: 'C:\\work',
          },
          integrator: {
            argv: ['claude.exe', '--restricted', '-p', '{prompt_file}'],
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
});
afterEach(() => {
  const home = process.env['DSH_HOME'];
  if (savedDshHome === undefined) delete process.env['DSH_HOME'];
  else process.env['DSH_HOME'] = savedDshHome;
  if (home) rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

function backups(): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('relay.patch.yml.bak-'));
}

function bytes(): { config: string; patch: string } {
  return { config: readFileSync(configPath, 'utf8'), patch: readFileSync(patchPath, 'utf8') };
}

function expectRejected(
  role: 'reviewer' | 'integrator' | 'developer',
  value: string | null,
): string {
  const before = bytes();
  const bakBefore = backups().length;
  let msg = '';
  try {
    setRelayModel({ relayDir: dir }, { role, value });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  expect(msg, '应当被拒绝').toBeTruthy();
  expect(bytes()).toEqual(before);
  expect(backups().length).toBe(bakBefore);
  return msg;
}

describe('MP3f 条件 16：审查不能跟开发同一个模型（两个方向）', () => {
  it('开发已是 gpt-x → 审查选 gpt-x 被拒，提示有「审查」「开发」和 gpt-x', () => {
    setRelayModel({ relayDir: dir }, { role: 'developer', value: 'gw-a / gpt-x' });
    const msg = expectRejected('reviewer', 'gpt-x');
    expect(msg).toContain('审查');
    expect(msg).toContain('开发');
    expect(msg).toContain('gpt-x');
  });

  it('审查已是 gpt-x → 开发选 gpt-x 被拒', () => {
    setRelayModel({ relayDir: dir }, { role: 'reviewer', value: 'gpt-x' });
    const msg = expectRejected('developer', 'gw-a / gpt-x');
    expect(msg).toContain('审查');
    expect(msg).toContain('gpt-x');
  });
});

describe('MP3f 条件 17：整合与开发', () => {
  it('开发是 claude-opus-x → 整合选 opus 被拒、选 sonnet 可以', () => {
    setRelayModel({ relayDir: dir }, { role: 'developer', value: 'gw-c / claude-opus-x' });
    const msg = expectRejected('integrator', 'opus');
    expect(msg).toContain('整合');
    expect(msg).toContain('开发');
    expect(() =>
      setRelayModel({ relayDir: dir }, { role: 'integrator', value: 'sonnet' }),
    ).not.toThrow();
  });

  it('整合选 magpie 的模型（id 里带斜杠）跟开发撞了也拦', () => {
    setRelayModel({ relayDir: dir }, { role: 'developer', value: 'gw-a / gpt-x' });
    setRelayModel(
      { relayDir: dir, magpieModels: ['vendor/gpt-x', 'gpt-x'] },
      { role: 'integrator', value: 'vendor/gpt-x' },
    );
    const before = bytes();
    let msg = '';
    try {
      setRelayModel(
        { relayDir: dir, magpieModels: ['vendor/gpt-x', 'gpt-x'] },
        { role: 'integrator', value: 'gpt-x' },
      );
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('整合');
    expect(msg).toContain('gpt-x');
    expect(bytes()).toEqual(before);
  });

  it('一边是「默认」/「跟 Codex 自己的设置」→ 不拦', () => {
    setRelayModel({ relayDir: dir }, { role: 'developer', value: 'gw-a / gpt-x' });
    expect(() => setRelayModel({ relayDir: dir }, { role: 'reviewer', value: null })).not.toThrow();
    expect(() =>
      setRelayModel({ relayDir: dir }, { role: 'integrator', value: '默认' }),
    ).not.toThrow();
  });

  it('开发是分组（group/ 开头）→ 不拦，开发那行 note 有提醒', () => {
    setRelayModel(
      { relayDir: dir, magpieModels: ['group/合成组'] },
      { role: 'developer', value: 'magpie / group/合成组' },
    );
    const models = readRelayModels({ relayDir: dir });
    const dev = models.roles.find((r) => r.role === 'developer')!;
    expect(String(dev.note ?? '')).toContain('分组里有哪些模型');
    expect(() =>
      setRelayModel({ relayDir: dir }, { role: 'reviewer', value: 'gpt-x' }),
    ).not.toThrow();
  });
});
