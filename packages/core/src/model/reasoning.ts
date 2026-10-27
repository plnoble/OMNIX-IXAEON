/**
 * ReasoningState（RFC-002）：推理内容的四态。
 *
 * 为什么不能只看「字段有没有值」：
 * 「模型这轮确实没产生推理」（合法）与「客户端漏传了历史推理」（错误）在协议上都是「空」，
 * 但处理方式相反——前者必须容忍，后者必须能诊断。
 * 外部实证：deepseek-recipe@935817c66f5d 的 protocol/reasoning_content.rs 用三条件才拒绝，
 * 并用 tool call id 上的 `ET_` 带内标记区分两种情况（protocol/tool_call_id.rs）。
 *
 * 我们踩过的坑：`The reasoning_content in the thinking mode must be passed back`。
 */
export type ReasoningState =
  | { kind: 'absent_legal' } // thinking 轮，模型确实没产生推理：容忍（补空）
  | { kind: 'present'; text: string } // 有推理内容：原样回传
  | { kind: 'not_applicable' } // 非 thinking 轮：丢弃，不保留不报错
  | { kind: 'missing' }; // 应有但没有：由 provider 严格档决定补空还是报错

export interface ReasoningRules {
  /** 该轮是否为 thinking 模式。 */
  thinking: boolean;
  /** provider 是否支持严格模式（严格档下 missing 报错，否则补空并留审计）。 */
  strict: boolean;
}

export type ReasoningRenderResult = { ok: true; text: string } | { ok: false; message: string };

/**
 * 把四态渲染成「要回传给模型的推理文本」。
 *
 * 规则（与外部实证对齐）：
 * - 非 thinking 轮：一律丢弃（`{ok:true, text:''}`），不报错；
 * - thinking + present：原样回传；
 * - thinking + absent_legal：补空串，**不报错**（这是合法的「无推理」）；
 * - thinking + missing：严格档报可诊断错误；非严格档补空（由调用方记录审计）。
 */
export function renderReasoningFor(
  state: ReasoningState,
  rules: ReasoningRules,
): ReasoningRenderResult {
  if (!rules.thinking) return { ok: true, text: '' };
  switch (state.kind) {
    case 'present':
      return { ok: true, text: state.text };
    case 'absent_legal':
    case 'not_applicable':
      return { ok: true, text: '' };
    case 'missing':
      if (rules.strict) {
        return {
          ok: false,
          message:
            'thinking 模式下缺少 reasoning_content，且未标记为「本轮无推理」；' +
            '请补传历史推理，或把该轮标为 absent_legal',
        };
      }
      return { ok: true, text: '' };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
