/**
 * CF3 验收（core，规格 docs/委派/CF3-直连模型做聊天主引擎.md）——条件 8。
 *
 * 逐条对应规格「验收条件」：
 * - 条件 8：系统提示词含 `search_memory`、`search_web`、「资料」和「不」连用（资料不够不编）、
 *   「AI 建议」；**不含** `SUGGESTED_TODOS_INSTRUCTION` 的任何一行；
 *   不含「建议待办」四个字**作为要求附加**的内容；`DIRECT_CHAT_TOOL_NAMES` 正好是那五个。
 *   另：`DIRECT_CHAT_PROMPT_VERSION` 是 'd1'（规格「要什么」第 3 条）。
 *
 * 「建议待办」的判法说明：规格第 3 条要求提示词里**出现**一句「不要在回答末尾附『建议待办』」，
 * 所以这里不能简单断言「全文不含这四个字」——而是断言它**只出现在否定语境**：
 * 每一处出现的那一行都必须带 不要 / 不许 / 别 / 无需 之一，才算「不是要求附加」。
 */
import { describe, expect, it } from 'vitest';
import {
  DIRECT_CHAT_PROMPT_VERSION,
  DIRECT_CHAT_SYSTEM_PROMPT,
  DIRECT_CHAT_TOOL_NAMES,
  SUGGESTED_TODOS_INSTRUCTION,
} from '../../src/index.js';

describe('CF3 条件 8：直连聊天的系统提示词与工具名单', () => {
  it('提示词版本号是 d1', () => {
    expect(DIRECT_CHAT_PROMPT_VERSION).toBe('d1');
  });

  it('含 search_memory 与 search_web 两个工具名', () => {
    expect(DIRECT_CHAT_SYSTEM_PROMPT).toContain('search_memory');
    expect(DIRECT_CHAT_SYSTEM_PROMPT).toContain('search_web');
  });

  it('含「资料」与「不」连用的说法（资料不够不编）', () => {
    expect(DIRECT_CHAT_SYSTEM_PROMPT).toMatch(/资料[^。\n]{0,24}不/);
  });

  it('含「AI 建议」的说明', () => {
    expect(DIRECT_CHAT_SYSTEM_PROMPT).toContain('AI 建议');
  });

  it('不含 SUGGESTED_TODOS_INSTRUCTION 的任何一行', () => {
    const lines = SUGGESTED_TODOS_INSTRUCTION.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 8);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(DIRECT_CHAT_SYSTEM_PROMPT).not.toContain(line);
    }
  });

  it('「建议待办」只出现在否定语境，不作为要求附加', () => {
    const hits = DIRECT_CHAT_SYSTEM_PROMPT.split('\n').filter((line: string) =>
      line.includes('建议待办'),
    );
    for (const line of hits) {
      expect(line).toMatch(/不要|不许|别|无需/);
    }
    // 至少要有那句否定（规格第 3 条要求写进去）
    expect(hits.length).toBeGreaterThan(0);
  });

  it('DIRECT_CHAT_TOOL_NAMES 正好是那五个，顺序一致', () => {
    expect([...DIRECT_CHAT_TOOL_NAMES]).toEqual([
      'search_memory',
      'get_evidence',
      'get_project_context',
      'search_web',
      'read_web',
    ]);
  });
});
