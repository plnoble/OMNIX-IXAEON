/**
 * T2a 验收（整合方写死，执行方不改）：聊天里的待办——AI 在回答末尾列「建议待办」，
 * 你在消息开头写「待办：」直接加一条。
 * 委派单：docs/委派/T2a-聊天里的待办.md
 *
 * 为什么不用工具调用：Hermes 聊天里模型只有联网与记忆桥（默认关）两类工具，提不了待办；
 * 让模型在回答末尾按固定格式列出、由代码解析，不依赖任何工具开关。
 */
import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_TODOS_INSTRUCTION,
  extractSuggestedTodos,
  parseUserTodo,
} from '../../src/index.js';

describe('回答末尾的「建议待办」', () => {
  it('取出列表，回答里去掉这一段', () => {
    const r = extractSuggestedTodos(
      '先把报价核一遍，再发给客户。\n\n建议待办：\n- 周五前把报价发给客户\n- 预约下周体检',
    );
    expect(r.answer).toBe('先把报价核一遍，再发给客户。');
    expect(r.todos).toEqual(['周五前把报价发给客户', '预约下周体检']);
  });

  it('认得常见写法：英文冒号、加粗标题、数字或圆点编号', () => {
    for (const heading of ['建议待办:', '**建议待办：**', '### 建议待办：']) {
      const r = extractSuggestedTodos(
        `正文。\n${heading}\n1. 第一件\n2) 第二件\n• 第三件\n* 第四件`,
      );
      expect(r.answer).toBe('正文。');
      expect(r.todos).toEqual(['第一件', '第二件', '第三件', '第四件']);
    }
  });

  it('列表后面还有话：那几句留在回答里', () => {
    const r = extractSuggestedTodos('正文。\n\n建议待办：\n- 甲\n- 乙\n\n有需要再叫我。');
    expect(r.answer).toBe('正文。\n\n有需要再叫我。');
    expect(r.todos).toEqual(['甲', '乙']);
  });

  it('最多 5 件；空的去掉；重复的去掉；每件最长 80 字', () => {
    const lines = ['- 一', '- 二', '- ', '- 二', '- 三', '- 四', '- 五', '- 六'].join('\n');
    const r = extractSuggestedTodos(`正文。\n建议待办：\n${lines}\n- ${'长'.repeat(120)}`);
    expect(r.todos).toEqual(['一', '二', '三', '四', '五']);
    const long = extractSuggestedTodos(`建议待办：\n- ${'长'.repeat(120)}`);
    expect(long.todos[0]!.length).toBe(80);
  });

  it('没有这一段：回答原样，待办为空；正文里顺口提到「建议待办」不算', () => {
    const plain = '今天不用做什么。';
    expect(extractSuggestedTodos(plain)).toEqual({ answer: plain, todos: [] });
    const inline = '我的建议待办事项不多，先休息。';
    expect(extractSuggestedTodos(inline)).toEqual({ answer: inline, todos: [] });
  });
});

describe('你自己在消息开头写「待办：」', () => {
  it.each([
    ['待办：周五前交报销单', '周五前交报销单'],
    ['待办: 周五前交报销单', '周五前交报销单'],
    ['  记个待办：给妈妈打电话', '给妈妈打电话'],
    ['加个待办：续费域名', '续费域名'],
    ['加待办：续费域名', '续费域名'],
  ])('%s', (message, title) => {
    expect(parseUserTodo(message)).toBe(title);
  });

  it.each([['待办：'], ['待办'], ['帮我看看待办：有哪些'], ['今天的待办：多吗？']])(
    '不算：%s',
    (message) => {
      expect(parseUserTodo(message)).toBeNull();
    },
  );
});

describe('告诉 Hermes 怎么列', () => {
  it('约定里写明标题「建议待办：」、每行「- 」开头、最多 5 件、没有就不写', () => {
    expect(SUGGESTED_TODOS_INSTRUCTION).toContain('建议待办：');
    expect(SUGGESTED_TODOS_INSTRUCTION).toContain('- ');
    expect(SUGGESTED_TODOS_INSTRUCTION).toContain('5');
    expect(SUGGESTED_TODOS_INSTRUCTION).toMatch(/没有就不写|不需要就不写/);
    // 自己写的约定，解析得回来
    expect(extractSuggestedTodos(`正文。\n\n建议待办：\n- 示例`).todos).toEqual(['示例']);
  });
});
