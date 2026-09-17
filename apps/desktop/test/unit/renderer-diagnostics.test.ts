/**
 * 界面报错写日志前的去内容处理（2026-09-17 黑屏排查的后续）。
 * 日志对 error/message 字段整体只留哈希，界面报错因此完全无法排查；
 * 这里验证：技术特征保留，可能是用户资料的部分去掉。
 */
import { describe, expect, it } from 'vitest';
import { errorSignature } from '../../src/main/rendererDiagnostics.js';

describe('errorSignature：保留技术特征、去掉资料内容', () => {
  it('纯技术报错原样保留（含短标识符）', () => {
    expect(
      errorSignature("Uncaught TypeError: Cannot read properties of undefined (reading 'join')"),
    ).toBe("Uncaught TypeError: Cannot read properties of undefined (reading 'join')");
    expect(errorSignature('Uncaught Error: prompt() is not supported.')).toBe(
      'Uncaught Error: prompt() is not supported.',
    );
  });

  it('中文内容整段去掉，只留错误码', () => {
    const s = errorSignature(
      "Error invoking remote method 'ixaeon:askQuestion': Error: IXA0010 模型未配置：请在设置中填写 OpenAI API Key",
    );
    expect(s).toContain("'ixaeon:askQuestion'");
    expect(s).toContain('IXA0010');
    expect(s).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('真机日志里出现过的资料标题不会进日志', () => {
    const s = errorSignature(
      '分析「设计低延迟同传方案」时，模型给的 1 条依据对不上原文（摘录：手机语音：纯软件无法做到真正 100% 覆盖所有 App。）',
    );
    expect(s).not.toContain('同传');
    expect(s).not.toContain('手机语音');
    expect(s).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('长的英文引号内文本去掉（可能是用户写的英文内容）', () => {
    const s = errorSignature(
      `Error: failed to save "my private note about the quarterly budget review"`,
    );
    expect(s).not.toContain('quarterly budget');
    expect(s).toContain('failed to save');
  });

  it('截断到 200 字，空白归一', () => {
    const s = errorSignature(`Error:   ${'x'.repeat(500)}\n  more`);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s).not.toMatch(/\s{2,}/);
  });
});
