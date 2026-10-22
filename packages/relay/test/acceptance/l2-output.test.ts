/**
 * L2 验收测试（一）：认得真命令行的输出（规格 docs/委派/L2-接上真的命令行.md 条件 1，对应契约第 1 条）。
 *
 * 逐条对应：
 * - 条件 1：Claude 的标准输出是一整个 JSON、`result` 里有两行 `RELAY-DONE`（中间隔着别的字）→ `doneLine`
 *   是后一行，`total_cost_usd` 照记；DSH 的 JSONL 里 `final.text` 里有 `RELAY-DONE` → 认出来；
 *   普通文字的输出照旧；三种都没有 → `null`。
 *
 * 替身照 L0 / L0b 交付说明里的真实输出形状造：Claude 是一整块 JSON（`result` 里的换行是 `\n`），
 * DSH 是一行一个 JSON。纯函数，不调真模型、不碰文件。
 */
import { describe, expect, it } from 'vitest';
import { parseRoleOutput } from '../../src/index.js';

/** Claude `--output-format json` 的形状（L0 交付说明里的原样字段）。 */
const claude = (result: string, cost = 0.14) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    total_cost_usd: cost,
    usage: { input_tokens: 12, output_tokens: 4 },
  });

/** DSH `--json` 的一行（L0 交付说明里 `type: final` 那一行）。 */
const dshFinal = (text: string) =>
  JSON.stringify({ type: 'final', text, usage: { input_tokens: 3, output_tokens: 2 } });

describe('条件 1：三种输出里的 RELAY-DONE', () => {
  it('Claude：result 里两行 RELAY-DONE，中间隔着别的字 → doneLine 是后一行，total_cost_usd 照记', () => {
    const stdout = claude(
      'RELAY-DONE 60 进行中（dev）\n中间隔着别的字\nRELAY-DONE 60 测试待审（整合方）',
    );
    const r = parseRoleOutput(stdout);
    expect(r.doneLine).toBe('RELAY-DONE 60 测试待审（整合方）');
    expect(r.usage?.costUsd).toBe(0.14);
  });

  it('DSH：JSONL 里 final.text 里有 RELAY-DONE → 认出来', () => {
    const stdout = [
      JSON.stringify({ type: 'item', text: '先看队列' }),
      dshFinal('做完了。\nRELAY-DONE 61 待复审（整合方）'),
    ].join('\n');
    expect(parseRoleOutput(stdout).doneLine).toBe('RELAY-DONE 61 待复审（整合方）');
  });

  it('普通文字的输出照旧：按行找 RELAY-DONE', () => {
    const stdout = '替身跑完了\nRELAY-DONE 62 已完成（2026-10-21）\n';
    expect(parseRoleOutput(stdout).doneLine).toBe('RELAY-DONE 62 已完成（2026-10-21）');
  });

  it('三种都没有 → doneLine 是 null', () => {
    expect(parseRoleOutput('替身什么都没说\n').doneLine).toBeNull();
    expect(parseRoleOutput(claude('做完了，但忘了打那一行')).doneLine).toBeNull();
    expect(parseRoleOutput(dshFinal('没有那一行')).doneLine).toBeNull();
  });

  it('几处都有时取最后出现的那一行', () => {
    const stdout = [
      'RELAY-DONE 1 先写在普通文字里',
      claude('RELAY-DONE 1 写在 result 里'),
      dshFinal('RELAY-DONE 1 写在 final 里'),
    ].join('\n');
    expect(parseRoleOutput(stdout).doneLine).toBe('RELAY-DONE 1 写在 final 里');
  });
});
