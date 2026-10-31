/**
 * CF0 验收（核心层，规格 docs/委派/CF0-聊天先能用.md）
 *
 * 逐条对应规格「验收条件」：
 * - 条件 1：`HTTP 503: No available channel for model demo-a …` 的说明含 demo-a、
 *   「没有可用渠道」「换一个模型」，不含「稍后再试」；`isModelUnavailable` 返回 `{ model: 'demo-a' }`。
 * - 条件 2：`model_not_found`、`The model \`demo-b\` does not exist` 也认（后者取到 demo-b）；
 *   取不到模型名时说明写「这个模型」。规格要求 1 里列的 `model <名字> not found` 同样要认。
 * - 条件 3：`HTTP 502: Bad Gateway`、`HTTP 429 …`、超时、`HTTP 401 …` 的说明和改之前逐字一样；
 *   `isModelUnavailable` 对它们返回 `null`。
 */
import { describe, expect, it } from 'vitest';
import { explainModelFailure, isModelUnavailable } from '@ixaeon/core';

describe('CF0 模型没渠道时说清是哪个模型（核心层）', () => {
  it('条件 1：No available channel for model <名字> 说清模型，并给补渠道/换模型两条路', () => {
    const detail =
      'HTTP 503: No available channel for model demo-a under group default (distributor)';
    const text = explainModelFailure(detail);
    expect(text).toContain('demo-a');
    expect(text).toContain('没有可用渠道');
    expect(text).toContain('换一个模型');
    expect(text).not.toContain('稍后再试');
    expect(text).toContain('（原始错误：HTTP 503: No available channel for model demo-a');
    expect(isModelUnavailable(detail)).toEqual({ model: 'demo-a' });
  });

  it('条件 2：model_not_found 也认，取不到模型名就写「这个模型」', () => {
    const detail = 'HTTP 500: {"error":{"code":"model_not_found"}}';
    const text = explainModelFailure(detail);
    expect(text).toContain('这个模型');
    expect(text).toContain('没有可用渠道');
    expect(text).not.toContain('稍后再试');
    expect(isModelUnavailable(detail)).toEqual({ model: null });
  });

  it('条件 2：The model `demo-b` does not exist 取到 demo-b', () => {
    const detail = 'HTTP 400: The model `demo-b` does not exist';
    const text = explainModelFailure(detail);
    expect(text).toContain('demo-b');
    expect(text).toContain('没有可用渠道');
    expect(text).not.toContain('稍后再试');
    expect(isModelUnavailable(detail)).toEqual({ model: 'demo-b' });
  });

  it('条件 2（规格要求 1 第三种）：model <名字> not found 也认', () => {
    const detail = 'HTTP 404: model demo-c not found';
    const text = explainModelFailure(detail);
    expect(text).toContain('demo-c');
    expect(text).toContain('没有可用渠道');
    expect(isModelUnavailable(detail)).toEqual({ model: 'demo-c' });
  });

  it('条件 3：502 的说明和改之前逐字一样，不认成没渠道', () => {
    const detail = 'HTTP 502: Bad Gateway';
    expect(explainModelFailure(detail)).toBe(
      '模型网关或它的上游暂时出错，稍后再试。（原始错误：HTTP 502: Bad Gateway）',
    );
    expect(isModelUnavailable(detail)).toBeNull();
  });

  it('条件 3：429 的说明和改之前逐字一样，不认成没渠道', () => {
    const detail = 'HTTP 429: Too Many Requests';
    expect(explainModelFailure(detail)).toBe(
      '模型网关同时处理的请求数到上限了——常见原因是后台分析正占着同一个账号。' +
        '现在提问时后台分析会先让路，稍等几秒再问一次即可。' +
        '（原始错误：HTTP 429: Too Many Requests）',
    );
    expect(isModelUnavailable(detail)).toBeNull();
  });

  it('条件 3：超时的说明和改之前逐字一样，不认成没渠道', () => {
    const detail = '请求超时 timeout';
    expect(explainModelFailure(detail)).toBe(
      '模型太久没有回应。推理型模型（先「思考」再回答）会慢很多，可以在' +
        '「设置 → 模型接入 → 聊天模型」换一个快一点的。' +
        '（原始错误：请求超时 timeout）',
    );
    expect(isModelUnavailable(detail)).toBeNull();
  });

  it('条件 3：401 的说明和改之前逐字一样，不认成没渠道', () => {
    const detail = 'HTTP 401: Unauthorized';
    expect(explainModelFailure(detail)).toBe(
      '模型网关拒绝了请求：Key 无效，或这个 Key 没有该模型的权限。' +
        '（原始错误：HTTP 401: Unauthorized）',
    );
    expect(isModelUnavailable(detail)).toBeNull();
  });
});
