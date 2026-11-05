/**
 * MP3c 验收条件 5：`resolveCodexLocator(input?)` 传参数时交给 `detectDevTools`。
 *
 * 测：手填的在 → `exe` 是手填的；手填的不在 → `null`（不往下自动找）。
 * 不传参数的行为跟现在一样（本文件不测旧行为，旧锁定测试覆盖）。
 *
 * 现在 `resolveCodexLocator` 还不接受参数、`detectDevTools` 也没有，本文件应当红。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as core from '@ixaeon/core';

interface Locator {
  exe: string;
}
type ResolveFn = (input?: {
  manual?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
}) => Locator | null;

function resolve(input?: Parameters<ResolveFn>[0]): Locator | null {
  const fn = (core as unknown as Record<string, unknown>)['resolveCodexLocator'] as ResolveFn;
  expect(typeof fn).toBe('function');
  return fn(input);
}

const ENV = {
  LOCALAPPDATA: join('C:', 'fake', 'LocalAppData'),
} as NodeJS.ProcessEnv;

describe('MP3c 条件 5：resolveCodexLocator(input)', () => {
  it('手填的在 → exe 是手填的', () => {
    const manual = join('C:', 'tools', 'codex.exe');
    const found = resolve({
      manual,
      env: ENV,
      exists: (p) => p.replaceAll('\\', '/') === manual.replaceAll('\\', '/'),
    });
    expect(found?.exe).toBe(manual);
  });

  it('手填的不在 → null（不往自动路径找）', () => {
    const auto = join(ENV.LOCALAPPDATA!, 'OpenAI', 'Codex', 'bin', 'codex.exe');
    const found = resolve({
      manual: join('C:', 'nope', 'codex.exe'),
      env: ENV,
      exists: (p) => p.replaceAll('\\', '/') === auto.replaceAll('\\', '/'),
    });
    expect(found).toBeNull();
  });
});
