/**
 * L2b 验收测试（三）：配置样例（规格条件 7，对应契约第 5 条）。
 *
 * 逐条对应：
 * - 条件 7：`config.example.json` 是合法 JSON；把占位符换成存在的临时目录之后 `checkConfig` 放行；
 *   里面没有任何「跳过所有权限」的开关。
 *
 * 只读仓库里的样例文件，不调真模型。
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConfig, FORBIDDEN_SWITCHES, type RelayConfig } from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const text = readFileSync(join(process.cwd(), 'packages', 'relay', 'config.example.json'), 'utf8');

describe('条件 7：配置样例', () => {
  it('是合法 JSON', () => {
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('里面没有任何「跳过所有权限」的开关', () => {
    for (const sw of FORBIDDEN_SWITCHES) {
      expect(text, `样例里不该有 ${sw}`).not.toContain(sw);
    }
  });

  it('把占位符换成存在的临时目录之后 checkConfig 放行', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ixa-l2b-cfg-'));
    dirs.push(cwd);
    const config = JSON.parse(text) as RelayConfig;
    for (const role of [config.roles.integrator, config.roles.developer]) {
      role.cwd = cwd;
      role.argv = role.argv.map((a) => a.replace(/<[^>]+>/g, 'git:*'));
    }
    expect(checkConfig(config)).toEqual({ ok: true });
  });
});
