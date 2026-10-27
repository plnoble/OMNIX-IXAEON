/**
 * DS3 验收条件（保守方案，统筹 2026-10-27 任务书 §8 定稿）。
 * 对应 §8.2 的四条验收目标，逐条钉死：
 *
 * 1. 多轮顺序：system/user/assistant/tool 经 `renderConversation` 后**角色与顺序不丢**；
 * 2. reasoning 不丢：四态按规则渲染（present 保文本、absent_legal 补空不编造、
 *    非 thinking 一律丢、missing/孤儿 tool 结构**抛错且零输出**）；
 * 3. provider adapter 正确：渲染结果喂给**现有** ModelProvider（chatText），多轮语义真的到达模型侧；
 * 4. 现有单轮路径不回归：旧入口行为一字不变。
 *
 * 钉死的接缝（改名等于改契约，整合方锁定时可改）：
 * - `renderConversation(conversation, rules?) => RenderedConversation`（纯函数，校验在前）；
 * - `toProviderPrompt(rendered) => { system: string; user: string }`（把多轮压成现有接口形态；
 *   格式由实现定义，但每个角色与文本都必须在输出里可见且保持顺序）。
 * - **不改 `ModelProvider` 接口**（§8.1 第一阶段硬约束）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider } from '../../src/extraction/model/fake.js';
import type { CanonicalMessage } from '../../src/model/canonical.js';
import { renderConversation, toProviderPrompt } from '../../src/model/render.js';

const conv = (messages: CanonicalMessage[]) => ({ messages });

describe('条件 1：多轮角色与顺序穿过渲染不丢', () => {
  it('四条消息按原顺序、原角色出现在渲染结果里', () => {
    const r = renderConversation(
      conv([
        { role: 'system', text: '你是助手' },
        { role: 'user', text: '第一问' },
        { role: 'assistant', text: '第一答' },
        { role: 'user', text: '第二问' },
      ]),
    );
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(r.messages.map((m) => m.text)).toEqual(['你是助手', '第一问', '第一答', '第二问']);
  });

  it('压成 provider 输入后，每一轮都仍可见且顺序可检', () => {
    const r = renderConversation(
      conv([
        { role: 'user', text: '甲' },
        { role: 'assistant', text: '乙' },
        { role: 'user', text: '丙' },
      ]),
    );
    const p = toProviderPrompt(r);
    const combined = `${p.system}\n${p.user}`;
    expect(combined.indexOf('甲')).toBeGreaterThanOrEqual(0);
    expect(combined.indexOf('甲')).toBeLessThan(combined.indexOf('乙'));
    expect(combined.indexOf('乙')).toBeLessThan(combined.indexOf('丙'));
    // 每一轮都有角色标记（不是裸文本拼接）
    expect(combined).toContain('user');
    expect(combined).toContain('assistant');
  });
});

describe('条件 2：reasoning 四态按规则渲染，坏结构零输出', () => {
  it('present 保文本；absent_legal 补空不编造；非 thinking 丢弃', () => {
    const withReasoning = conv([
      { role: 'user', text: '问' },
      { role: 'assistant', text: '答', reasoning: { kind: 'present', text: '想了很久' } },
    ]);
    const thinking = renderConversation(withReasoning, { thinking: true, strict: true });
    expect(thinking.messages[1]!.reasoning).toBe('想了很久');

    const absent = conv([
      { role: 'user', text: '问' },
      { role: 'assistant', text: '答', reasoning: { kind: 'absent_legal' } },
    ]);
    const r2 = renderConversation(absent, { thinking: true, strict: true });
    expect(r2.messages[1]!.reasoning).toBe('');

    const ignored = renderConversation(withReasoning, { thinking: false, strict: false });
    expect(ignored.messages[1]!.reasoning).toBe('');
  });

  it('missing 在严格档抛可诊断错误（带消息序号），且不产出半截渲染', () => {
    expect(() =>
      renderConversation(
        conv([
          { role: 'user', text: '问' },
          { role: 'assistant', text: '答', reasoning: { kind: 'missing' } },
        ]),
        { thinking: true, strict: true },
      ),
    ).toThrow(/第 2 条/);
  });

  it('tool 消息引用不存在的 call → 渲染期抛错（坏结构不许发给模型）', () => {
    expect(() =>
      renderConversation(
        conv([
          { role: 'user', text: '问' },
          { role: 'tool', text: '孤儿', toolCallId: 'call_不存在' },
        ]),
      ),
    ).toThrow();
  });

  it('合法的 tool 往返完整保留 id 与参数', () => {
    const r = renderConversation(
      conv([
        { role: 'user', text: '查天气' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'call_1', name: 'weather', argumentsJson: '{"city":"北京"}' }],
        },
        { role: 'tool', text: '晴', toolCallId: 'call_1' },
      ]),
    );
    expect(r.messages[1]!.toolCalls?.[0]?.id).toBe('call_1');
    expect(r.messages[2]!.toolCallId).toBe('call_1');
  });
});

describe('条件 3：渲染结果经现有 ModelProvider 真正到达模型侧', () => {
  it('toProviderPrompt 的输出直接喂现有 chatText，FakeProvider 收到的内容含全部轮次', async () => {
    const provider = new FakeProvider().enqueueText('最终答复');
    const p = toProviderPrompt(
      renderConversation(
        conv([
          { role: 'system', text: '规则' },
          { role: 'user', text: '一' },
          { role: 'assistant', text: '二' },
          { role: 'user', text: '三' },
        ]),
      ),
    );
    await expect(provider.chatText(p)).resolves.toBe('最终答复');
    const seen = provider.textCalls[0]!;
    const combined = `${seen.system}\n${seen.user}`;
    for (const turn of ['规则', '一', '二', '三']) {
      expect(combined).toContain(turn);
    }
  });
});

describe('条件 4：现有单轮路径不回归', () => {
  it('旧入口 chatText/chatStructured 的入参与行为保持原形状', async () => {
    const provider = new FakeProvider().enqueueText('旧答').enqueueStructured({ ok: true });
    await expect(provider.chatText({ system: 's', user: 'u' })).resolves.toBe('旧答');
    const out = await provider.chatStructured({
      system: 's',
      user: 'u',
      schema: z.object({ ok: z.boolean() }),
    });
    expect(out.ok).toBe(true);
    // DS2 测试钉过的记录形状未被本单改动
    expect(provider.textCalls[0]).toHaveProperty('system', 's');
    expect(provider.textCalls[0]).toHaveProperty('user', 'u');
  });
});
