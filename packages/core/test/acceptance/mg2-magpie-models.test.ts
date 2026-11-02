/**
 * MG2 验收（规格 docs/委派/MG2-角色走magpie轮动.md，B 档：本周例外，测试和实现一起在分支上）。
 *
 * 条件 1：合成 magpie 的 `/v1/models` 回 `a/m1`、`b/m2`、`group/rot` → 整合方、审查两行的选项
 *          都含这 3 个和「默认」；开发那行在原有选项之外也有这 3 个。合成服务没起 → 只有原来的
 *          选项、写「没连上 magpie」。
 * 条件 4：开发选 `magpie / group/rot` → 接力补丁里 agent-default-model 的 provider 是 magpie 那节
 *          的名字、model 是 group/rot，其余字节不变，先有 .bak- 备份。
 * 条件 5：不认识的值（不在 magpie 清单里、也不是「默认」）→ 拒绝，配置不变。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMagpieModels, readRelayModels, setRelayModel } from '@ixaeon/core';

const dirs: string[] = [];
const servers: Server[] = [];
const savedDshHome = process.env.DSH_HOME;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ixaeon-mg2-'));
  dirs.push(dir);
  return dir;
}

const PATCH = `- id: llm-pi-ai
  config:
    providers:
      gw-a:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: model-a1
            name: model-a1
      magpie:
        apiKeyEnv: SECRET-XYZ
        baseURL: https://gw.example.invalid
        models:
          - id: local-a
            name: local-a
- id: agent-default-model
  config:
    provider: gw-a
    model: model-a1
`;

const ALL_MAGPIE = ['a/m1', 'b/m2', 'group/rot'];

function makeRelay(): { dir: string; patch: string; config: string } {
  const dir = tempDir();
  const patch = join(dir, 'relay.patch.yml');
  writeFileSync(patch, PATCH, 'utf8');
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        roles: {
          developer: { argv: ['node', 'dsh.mjs', '--patch', patch] },
          integrator: { argv: ['claude.exe', '-p', '{prompt_file}'] },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { dir, patch, config };
}

async function startMagpie(ids: string[]): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models' || req.headers.authorization !== 'Bearer magpie') {
      res.statusCode = 401;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  // 一律把 DSH_HOME 指到空目录：不读本机真实的桌面版配置。
  process.env.DSH_HOME = tempDir();
});
afterEach(async () => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  for (const server of servers.splice(0)) await new Promise((r) => server.close(() => r(null)));
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上句柄没关干净时删不掉，留给系统临时目录 */
    }
  }
});

const rowOf = (models: ReturnType<typeof readRelayModels>, role: string) =>
  models.roles.find((r) => r.role === role)!;

describe('条件 1：magpie 的模型与分组进三行的选项', () => {
  it('合成服务起来 → 整合方 / 审查 / 开发都列 a/m1、b/m2、group/rot；默认仍在', async () => {
    const { dir } = makeRelay();
    const base = await startMagpie(ALL_MAGPIE);
    const listed = await listMagpieModels(base);
    expect(listed).toEqual({ models: ALL_MAGPIE, error: null });

    const models = readRelayModels({ relayDir: dir, magpieModels: listed.models });
    expect(rowOf(models, 'integrator').options).toEqual(
      expect.arrayContaining(['默认', ...ALL_MAGPIE]),
    );
    expect(rowOf(models, 'reviewer').options).toEqual(
      expect.arrayContaining(['默认', ...ALL_MAGPIE]),
    );
    expect(rowOf(models, 'developer').options).toEqual(
      expect.arrayContaining(ALL_MAGPIE.map((id) => `magpie / ${id}`)),
    );
    expect(rowOf(models, 'integrator').note).toBeNull();
  });

  it('合成服务没起 → 只有原来的选项，写「没连上 magpie」', async () => {
    const { dir } = makeRelay();
    const base = await startMagpie(ALL_MAGPIE);
    await new Promise((r) => servers.splice(0)[0]?.close(() => r(null)));
    const listed = await listMagpieModels(base);
    expect(listed.models).toEqual([]);
    expect(listed.error).toBe('没连上 magpie');

    const models = readRelayModels({
      relayDir: dir,
      magpieModels: listed.models,
      magpieError: listed.error,
    });
    expect(rowOf(models, 'integrator').options).toEqual(['默认', 'opus', 'sonnet', 'haiku']);
    expect(rowOf(models, 'reviewer').options).toEqual([]);
    expect(rowOf(models, 'developer').options).not.toContain('magpie / a/m1');
    for (const role of ['integrator', 'reviewer', 'developer']) {
      expect(rowOf(models, role).note).toBe('没连上 magpie');
    }
  });
});

describe('条件 4：开发选 magpie 的模型 → 只改默认模型那两行，先留备份', () => {
  it('provider 写 magpie、model 写 group/rot，其余字节不变', () => {
    const { dir, patch } = makeRelay();
    const before = readFileSync(patch, 'utf8');

    setRelayModel(
      { relayDir: dir, magpieModels: ['group/rot'] },
      { role: 'developer', value: 'magpie / group/rot' },
    );

    const after = readFileSync(patch, 'utf8');
    expect(after).toBe(
      before
        .replace('provider: gw-a', 'provider: magpie')
        .replace('model: model-a1', 'model: group/rot'),
    );
    const backups = readdirSync(dir).filter((f) => f.startsWith('relay.patch.yml.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(before);
    expect(rowOf(readRelayModels({ relayDir: dir }), 'developer').current).toBe(
      'magpie / group/rot',
    );
  });

  it('整合方 / 审查选 magpie 的值 → 记进 config 的 magpieModel，起棒时才带参数和环境变量', () => {
    const { dir, config } = makeRelay();
    setRelayModel(
      { relayDir: dir, magpieModels: ['group/rot'], magpieBase: 'http://127.0.0.1:3425' },
      { role: 'integrator', value: 'group/rot' },
    );
    setRelayModel(
      { relayDir: dir, magpieModels: ['a/m1'], magpieBase: 'http://127.0.0.1:3425' },
      { role: 'reviewer', value: 'a/m1' },
    );

    const saved = JSON.parse(readFileSync(config, 'utf8')) as {
      roles: { integrator: { argv: string[]; magpieModel?: string; magpieUrl?: string } };
      review: { magpieModel?: string; magpieUrl?: string; codexModel?: string };
    };
    expect(saved.roles.integrator.magpieModel).toBe('group/rot');
    expect(saved.roles.integrator.magpieUrl).toBe('http://127.0.0.1:3425');
    expect(saved.roles.integrator.argv).not.toContain('--model');
    expect(saved.review.magpieModel).toBe('a/m1');
    expect(saved.review.magpieUrl).toBe('http://127.0.0.1:3425');
    expect(saved.review.codexModel).toBeUndefined();

    const models = readRelayModels({ relayDir: dir });
    expect(rowOf(models, 'integrator').current).toBe('group/rot');
    expect(rowOf(models, 'reviewer').current).toBe('a/m1');
    // 整合方复审补：这次没连上 magpie，选过的值也还在下拉里（不会显示成「默认」）。
    expect(rowOf(models, 'integrator').options).toContain('group/rot');
  });

  it('整合方复审补：桌面版那一节手抄过的同名模型只列一次', () => {
    const { dir } = makeRelay();
    const options = rowOf(
      readRelayModels({ relayDir: dir, magpieModels: ['local-a', 'group/rot'] }),
      'developer',
    ).options;
    expect(options.filter((o) => o === 'magpie / local-a')).toHaveLength(1);
    expect(options).toContain('magpie / group/rot');
  });
});

describe('条件 5：不认识的值一律拒绝，文件不动', () => {
  const cases: Array<{ role: 'integrator' | 'reviewer' | 'developer'; value: string }> = [
    { role: 'integrator', value: 'group/nope' },
    { role: 'reviewer', value: 'group/nope' },
    { role: 'developer', value: 'magpie / group/nope' },
  ];

  for (const one of cases) {
    it(`${one.role} 传 ${one.value} → VALIDATION_FAILED、文件不变、没有备份`, () => {
      const { dir, patch, config } = makeRelay();
      const beforePatch = readFileSync(patch, 'utf8');
      const beforeConfig = readFileSync(config, 'utf8');
      let caught: unknown = null;
      try {
        setRelayModel(
          { relayDir: dir, magpieModels: ALL_MAGPIE },
          { role: one.role, value: one.value },
        );
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string }).code).toBe('IXA0012');
      expect(readFileSync(patch, 'utf8')).toBe(beforePatch);
      expect(readFileSync(config, 'utf8')).toBe(beforeConfig);
      expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toHaveLength(0);
    });
  }
});