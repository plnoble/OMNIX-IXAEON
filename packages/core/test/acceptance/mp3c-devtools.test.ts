/**
 * MP3c 验收条件 1、2、3：`detectDevTools` 找三个开发工具的位置（只看文件在不在，不运行）。
 *
 * 条件 1：手填优先——手填的在就 `source: 'manual'`；手填的不在就算没找到
 *         （note「手填的位置没有这个程序」），不再往下自动找。
 * 条件 2：没手填按顺序找第一个在的（`auto`）；都不在 → `found:false`、`path:null`、
 *         note「没找到，可以手填位置」；`IXAEON_CODEX_EXE=none` 算没找到。
 * 条件 3：DSH 安装目录下少 `DeepSeek Harness.exe` 或 `resources/app.asar` 任一个就算没找到。
 *
 * 现在 `detectDevTools` 还没实现，本文件红在「不是函数」——B 档先推测试的预期。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from '@ixaeon/core';

type Row = {
  tool: 'codex' | 'claude' | 'dsh';
  found: boolean;
  path: string | null;
  source: 'manual' | 'auto' | null;
  note: string | null;
};

interface DetectInput {
  manual: { codex?: string; claude?: string; dsh?: string };
  env: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}

/** 运行时取还没导出的函数：没有时是 undefined，调用时才报错。 */
function detect(input: DetectInput): Row[] {
  const fn = (core as unknown as Record<string, unknown>)['detectDevTools'];
  expect(typeof fn).toBe('function');
  return (fn as (i: DetectInput) => Row[])(input);
}

const ENV = {
  LOCALAPPDATA: join('C:', 'fake', 'LocalAppData'),
  USERPROFILE: join('C:', 'fake', 'User'),
  APPDATA: join('C:', 'fake', 'Roaming'),
} as NodeJS.ProcessEnv;

const CODEX_AUTO = join(ENV.LOCALAPPDATA!, 'OpenAI', 'Codex', 'bin', 'codex.exe');
const CLAUDE_AUTO = join(ENV.USERPROFILE!, '.local', 'bin', 'claude.exe');
const DSH_AUTO = join('D:', 'Agent', 'DeepSeek Harness', 'Install');
const DSH_EXE = join(DSH_AUTO, 'DeepSeek Harness.exe');
const DSH_ASAR = join(DSH_AUTO, 'resources', 'app.asar');

function existsOf(paths: string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => p.replaceAll('\\', '/')));
  return (p) => set.has(p.replaceAll('\\', '/'));
}

describe('MP3c 条件 1：手填优先', () => {
  it('手填的在 → manual；顺序固定 codex、claude、dsh', () => {
    const rows = detect({
      manual: { codex: join('C:', 'tools', 'codex.exe') },
      env: ENV,
      exists: existsOf([
        join('C:', 'tools', 'codex.exe'),
        CODEX_AUTO,
        CLAUDE_AUTO,
        DSH_EXE,
        DSH_ASAR,
      ]),
    });
    expect(rows.map((r) => r.tool)).toEqual(['codex', 'claude', 'dsh']);
    expect(rows[0]).toMatchObject({
      found: true,
      path: join('C:', 'tools', 'codex.exe'),
      source: 'manual',
    });
  });

  it('手填的不在 → 没找到（note 写明），不再往下自动找', () => {
    const rows = detect({
      manual: { codex: join('C:', 'nope', 'codex.exe') },
      env: ENV,
      // 自动路径都存在，但手填优先，不该退回去用它们
      exists: existsOf([CODEX_AUTO, CLAUDE_AUTO, DSH_EXE, DSH_ASAR]),
    });
    const codex = rows[0]!;
    expect(codex.found).toBe(false);
    expect(codex.path).toBeNull();
    expect(codex.source).toBeNull();
    expect(String(codex.note)).toContain('手填的位置没有这个程序');
  });
});

describe('MP3c 条件 2：没手填时按顺序自动找', () => {
  it('按顺序第一个在的算数（auto）', () => {
    const rows = detect({
      manual: {},
      env: ENV,
      exists: existsOf([CLAUDE_AUTO, DSH_EXE, DSH_ASAR]),
    });
    const codex = rows.find((r) => r.tool === 'codex')!;
    const claude = rows.find((r) => r.tool === 'claude')!;
    expect(codex.found).toBe(false);
    expect(claude).toMatchObject({ found: true, path: CLAUDE_AUTO, source: 'auto' });
  });

  it('都不在 → found:false、path:null、note「没找到，可以手填位置」', () => {
    const rows = detect({ manual: {}, env: ENV, exists: () => false });
    for (const r of rows) {
      expect(r.found).toBe(false);
      expect(r.path).toBeNull();
      expect(r.note).toBe('没找到，可以手填位置');
    }
  });

  it('IXAEON_CODEX_EXE=none 算没找到，note 写「已设成不用 Codex」', () => {
    const rows = detect({
      manual: {},
      env: { ...ENV, IXAEON_CODEX_EXE: 'none' },
      exists: existsOf([CODEX_AUTO]),
    });
    const codex = rows.find((r) => r.tool === 'codex')!;
    expect(codex.found).toBe(false);
    expect(codex.path).toBeNull();
    expect(String(codex.note)).toContain('已设成不用 Codex');
  });
});

describe('MP3c 条件 3：DSH 要同时有 exe 与 app.asar', () => {
  it('少 app.asar → 没找到', () => {
    const rows = detect({ manual: {}, env: ENV, exists: existsOf([DSH_EXE]) });
    const dsh = rows.find((r) => r.tool === 'dsh')!;
    expect(dsh.found).toBe(false);
    expect(dsh.path).toBeNull();
  });

  it('少 exe → 没找到', () => {
    const rows = detect({ manual: {}, env: ENV, exists: existsOf([DSH_ASAR]) });
    expect(rows.find((r) => r.tool === 'dsh')!.found).toBe(false);
  });

  it('两个都在 → auto，path 是安装目录', () => {
    const rows = detect({ manual: {}, env: ENV, exists: existsOf([DSH_EXE, DSH_ASAR]) });
    expect(rows.find((r) => r.tool === 'dsh')).toMatchObject({
      found: true,
      path: DSH_AUTO,
      source: 'auto',
    });
  });
});
