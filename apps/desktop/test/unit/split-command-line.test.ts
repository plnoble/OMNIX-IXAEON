// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { splitCommandLine } from '../../src/renderer/src/pages/Tasks.js';

describe('splitCommandLine', () => {
  it('按空格拆分', () => {
    expect(splitCommandLine('npm test')).toEqual({ argv: ['npm', 'test'], unclosed: false });
  });

  it('双引号内的空格不拆', () => {
    expect(splitCommandLine('node "my script.js" --x')).toEqual({
      argv: ['node', 'my script.js', '--x'],
      unclosed: false,
    });
  });

  it('连续空格不产生空参数，首尾空格忽略', () => {
    expect(splitCommandLine('  a   b  ')).toEqual({ argv: ['a', 'b'], unclosed: false });
  });

  it('引号未闭合视为输入错误', () => {
    expect(splitCommandLine('node "unclosed')).toEqual({
      argv: ['node', 'unclosed'],
      unclosed: true,
    });
  });
});
