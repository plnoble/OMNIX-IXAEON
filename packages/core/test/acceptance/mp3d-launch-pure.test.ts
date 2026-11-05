/**
 * MP3d 条件 12 / MP3e 条件 13：起进程参数与读结果写成纯函数（core 导出）。
 *
 * 12（Claude Code）：argv 逐项相等、选模型多 `--model`、没有那三个开关、cwd 是工作区、
 *                   `parseClaudeCodeOutput` 取 `result`、`is_error` 为真算失败。
 * 13（DSH）：程序 / 第一个参数 / 后面参数逐项相等；env 只多 `ELECTRON_RUN_AS_NODE=1`；
 *            `parseDshOutput` 取最后一行 `final` 的 `text`，没有 final 算失败。
 *
 * 现在这些纯函数还没导出，本文件红在「不是函数」。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from '@ixaeon/core';

type Launch = { command: string; args: string[]; cwd: string };
type DshLaunch = Launch & { env: NodeJS.ProcessEnv };

function fn<T>(name: string): T {
  const f = (core as unknown as Record<string, unknown>)[name];
  expect(typeof f, name).toBe('function');
  return f as T;
}

describe('MP3d 条件 12：claudeCodeLaunch / parseClaudeCodeOutput', () => {
  it('argv 逐项相等；选模型多 --model', () => {
    const launch = fn<(i: unknown) => Launch>('claudeCodeLaunch')({
      exe: 'C:/tools/claude.exe',
      goal: '写一条 note.txt',
      workspace: 'C:/ws',
      model: 'sonnet',
    });
    expect(launch.command).toBe('C:/tools/claude.exe');
    expect(launch.args).toEqual([
      '-p',
      '写一条 note.txt',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'sonnet',
    ]);
    expect(launch.cwd).toBe('C:/ws');
    expect(launch.args).not.toContain('--dangerously-skip-permissions');
    expect(launch.args).not.toContain('--add-dir');
    expect(launch.args).not.toContain('--allowedTools');
  });

  it('不选模型就不带 --model', () => {
    const launch = fn<(i: unknown) => Launch>('claudeCodeLaunch')({
      exe: 'C:/tools/claude.exe',
      goal: 'g',
      workspace: 'C:/ws',
    });
    expect(launch.args).not.toContain('--model');
  });

  it('parseClaudeCodeOutput：取 result；is_error 为真算失败', () => {
    const parse =
      fn<(stdout: string, code: number | null) => { ok: boolean; summary: string }>(
        'parseClaudeCodeOutput',
      );
    expect(parse('{"result":"done","is_error":false}', 0)).toEqual({ ok: true, summary: 'done' });
    expect(parse('{"result":"done","is_error":true}', 0).ok).toBe(false);
    expect(parse('{"result":"done","is_error":false}', 1).ok).toBe(false);
    expect(parse('不是 JSON', 0).ok).toBe(false);
  });
});

describe('MP3e 条件 13：dshLaunch / parseDshOutput', () => {
  it('程序、第一个参数、后面的参数逐项相等；env 只多 ELECTRON_RUN_AS_NODE=1', () => {
    const install = join('D:', 'fake', 'DeepSeek Harness', 'Install');
    const baseEnv = { PATH: 'x', HOME: 'y' } as NodeJS.ProcessEnv;
    const launch = fn<(i: unknown) => DshLaunch>('dshLaunch')({
      install,
      goal: '写一条 note.txt',
      workspace: 'C:/ws',
      baseEnv,
    });
    expect(launch.command).toBe(join(install, 'DeepSeek Harness.exe'));
    expect(launch.args[0]).toBe(
      join(
        install,
        'resources',
        'app.asar',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-desktop-host',
        'lib',
        'cli.js',
      ),
    );
    expect(launch.args.slice(1)).toEqual(['--profile', 'headless', '--json', '写一条 note.txt']);
    expect(launch.cwd).toBe('C:/ws');
    expect(launch.env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(launch.env['PATH']).toBe('x');
    // 只多这一项，别的一个不加；也不改传进来的 baseEnv
    expect(Object.keys(launch.env).sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'HOME', 'PATH']);
    expect(baseEnv['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(launch.env['IXAEON_WORKTREES']).toBeUndefined();
    expect(launch.env['GIT_CONFIG_PARAMETERS']).toBeUndefined();
  });

  it('parseDshOutput：取最后一行 final 的 text；没有 final 算失败', () => {
    const parse =
      fn<(stdout: string, code: number | null) => { ok: boolean; summary: string }>(
        'parseDshOutput',
      );
    const stdout = ['{"type":"log","text":"准备"}', '{"type":"final","text":"做完了"}'].join('\n');
    expect(parse(stdout, 0)).toEqual({ ok: true, summary: '做完了' });
    expect(parse('{"type":"log","text":"准备"}', 0).ok).toBe(false);
    // 好几行 final 取最后一行；退出码非 0 算失败；夹着不是 JSON 的行也不出错
    const many = [
      '{"type":"final","text":"第一次"}',
      '不是 JSON',
      '{"type":"final","text":"第二次"}',
    ].join('\n');
    expect(parse(many, 0)).toEqual({ ok: true, summary: '第二次' });
    expect(parse(stdout, 1).ok).toBe(false);
  });
});
