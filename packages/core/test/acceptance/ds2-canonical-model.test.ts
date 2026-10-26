/**
 * DS2 验收条件（B 档：先只推测试，整合方锁定后再写实现）。
 * 规格：docs/research/deepseek/adoption/rfc-proposals.md 的 RFC-001/002/003。
 *
 * 钉死的接缝（改名等于改契约）：
 * - `packages/core/src/model/canonical.ts` 导出 `CanonicalMessage`/`CanonicalConversation`/`CanonicalToolCall`；
 * - `packages/core/src/model/reasoning.ts` 导出 `ReasoningState` 与 `renderReasoningFor(provider 规则)`；
 * - `packages/core/src/model/capabilities.ts` 导出 `ModelCapabilities` 与 `ModelProvider.capabilities`；
 * - 旧接口 `chatText`/`chatStructured` 签名不变（增量，不破坏 20+ 调用点）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openDatabase, type CoreDatabase } from '../../src/index.js';
import { FakeProvider } from '../../src/extraction/model/fake.js';
import { type CanonicalConversation, type CanonicalMessage } from '../../src/model/canonical.js';
import { type ModelCapabilities } from '../../src/model/capabilities.js';
import { type ReasoningState } from '../../src/model/reasoning.js';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ixaeon-ds2-'));
  db = openDatabase(join(dir, 'ixaeon.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const conversation = (messages: CanonicalMessage[]): CanonicalConversation => ({ messages });

describe('条件 1（RFC-001）：CanonicalConversation 承载多轮结构，不再压成两个字符串', () => {
  it('消息数组保留角色与顺序，system/user/assistant 各就各位', () => {
    const c = conversation([
      { role: 'system', text: '你是助手' },
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一答' },
      { role: 'user', text: '第二问' },
    ]);
    expect(c.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(c.messages[3]!.text).toBe('第二问');
  });

  it('assistant 消息可带 reasoning 与 toolCalls 位；tool 消息带 toolCallId', () => {
    const c = conversation([
      { role: 'user', text: '查天气' },
      {
        role: 'assistant',
        text: '',
        reasoning: { kind: 'present', text: '需要调用工具' },
        toolCalls: [{ id: 'call_1', name: 'weather', argumentsJson: '{"city":"北京"}' }],
      },
      { role: 'tool', text: '晴', toolCallId: 'call_1' },
    ]);
    expect(c.messages[1]!.reasoning).toEqual({ kind: 'present', text: '需要调用工具' });
    expect(c.messages[1]!.toolCalls?.[0]?.name).toBe('weather');
    expect(c.messages[2]!.toolCallId).toBe('call_1');
  });

  it('旧的 chatText/chatStructured 签名仍然可用（等价于单轮 IR），不破坏既有调用点', async () => {
    // FakeProvider 按设计要求测试显式给足响应（队列空即报错），这里照它的既有约定喂数据
    const provider = new FakeProvider().enqueueText('答').enqueueStructured({ ok: true });
    await expect(provider.chatText({ system: 's', user: 'u' })).resolves.toBe('答');
    const out = await provider.chatStructured({
      system: 's',
      user: 'u',
      schema: z.object({ ok: z.boolean() }),
    });
    expect(out.ok).toBe(true);
    // 旧接口收到的仍是 system/user 两段（既有调用点语义未变）
    expect(provider.textCalls[0]).toEqual({ system: 's', user: 'u' });
  });
});

describe('条件 2（RFC-002）：ReasoningState 四态可区分，不靠「有没有值」', () => {
  it('四态各自可构造且互不相等（absent_legal ≠ missing）', () => {
    const absentLegal: ReasoningState = { kind: 'absent_legal' };
    const missing: ReasoningState = { kind: 'missing' };
    const present: ReasoningState = { kind: 'present', text: '推理' };
    const notApplicable: ReasoningState = { kind: 'not_applicable' };
    expect(absentLegal).not.toEqual(missing);
    expect(new Set([absentLegal.kind, missing.kind, present.kind, notApplicable.kind]).size).toBe(
      4,
    );
    // 核心要求：合法的「无推理」不能被当成「漏传」
    expect(absentLegal.kind).not.toBe(missing.kind);
  });

  it('thinking 模式下 absent_legal 渲染为空串而非报错；missing 在严格档报可诊断错误', async () => {
    const { renderReasoningFor } = await import('../../src/model/reasoning.js');
    expect(renderReasoningFor({ kind: 'absent_legal' }, { thinking: true, strict: false })).toEqual(
      { ok: true, text: '' },
    );
    const strict = renderReasoningFor({ kind: 'missing' }, { thinking: true, strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.ok === false && strict.message.length > 0).toBe(true);
    // 非 thinking 模式一律丢弃（不保留、不报错）
    expect(
      renderReasoningFor({ kind: 'present', text: '不该出现' }, { thinking: false, strict: true }),
    ).toEqual({ ok: true, text: '' });
  });

  it('present 原样回传（thinking 模式）', async () => {
    const { renderReasoningFor } = await import('../../src/model/reasoning.js');
    expect(
      renderReasoningFor({ kind: 'present', text: '推理内容' }, { thinking: true, strict: true }),
    ).toEqual({ ok: true, text: '推理内容' });
  });
});

describe('条件 3（RFC-003）：ModelCapabilities 声明能力，判断不靠模型名', () => {
  it('capabilities 包含结构化档位/seed/tools/vision/context，且 maxContext 未知时为 null 不猜', () => {
    const caps: ModelCapabilities = {
      structuredOutput: 'native-schema',
      seed: false,
      tools: false,
      vision: false,
      maxContext: null,
      streaming: true,
    };
    expect(caps.structuredOutput).toBe('native-schema');
    expect(caps.maxContext).toBeNull(); // 未知不猜数值
    expect(['native-schema', 'tool-call', 'validate-only']).toContain(caps.structuredOutput);
  });

  it('provider 暴露 capabilities；FakeProvider 声明的档位与其实际行为一致', () => {
    const provider = new FakeProvider();
    expect(provider.capabilities).toBeDefined();
    // 假模型只能「校验」，不该声称 native-schema
    expect(provider.capabilities.structuredOutput).toBe('validate-only');
    expect(provider.capabilities.seed).toBe(false);
  });

  it('结构化调用按能力选档：validate-only 的 provider 走的仍是 zod 校验路径', async () => {
    const provider = new FakeProvider().enqueueStructured({ n: 42 });
    const ok = await provider.chatStructured({
      system: 's',
      user: 'u',
      schema: z.object({ n: z.number() }),
    });
    expect(ok.n).toBe(42);
    // 假模型只能校验：不给对的结构就会拒绝（证明走的是校验路径而非「无条件信任」）
    const bad = new FakeProvider().enqueueStructured({ n: '不是数字' });
    await expect(
      bad.chatStructured({ system: 's', user: 'u', schema: z.object({ n: z.number() }) }),
    ).rejects.toThrow();
  });
});
