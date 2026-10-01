/**
 * D2 整合方复审（2026-10-01）：`codex --version` 的输出末尾带换行，旧的正则把换行吃进了
 * 版本号，拼出的 helper 文件名（codex-command-runner-<版本>.exe）永远不存在，授权好的
 * 配置也被判成「没授权」。版本号要到第一个空白为止。
 */
import { describe, expect, it } from 'vitest';
import { parseCodexVersion } from '../../src/execution/verifySandbox.js';

describe('parseCodexVersion', () => {
  it('末尾的换行（LF / CRLF）不算进版本号', () => {
    expect(parseCodexVersion('codex-cli 0.130.0-alpha.5\n')).toBe('0.130.0-alpha.5');
    expect(parseCodexVersion('codex-cli 0.130.0-alpha.5\r\n')).toBe('0.130.0-alpha.5');
  });

  it('正式版、后面还跟着别的字段', () => {
    expect(parseCodexVersion('codex-cli 1.2.3')).toBe('1.2.3');
    expect(parseCodexVersion('codex-cli 1.2.3 (build abc)\n')).toBe('1.2.3');
  });

  it('输出里没有版本号 → null', () => {
    expect(parseCodexVersion('')).toBeNull();
    expect(parseCodexVersion('codex-cli unknown\n')).toBeNull();
  });
});
