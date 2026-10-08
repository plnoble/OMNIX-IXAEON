/**
 * U5 验收（规格 docs/委派/U5-任务卡片说人话.md）里两句共用的话：
 * 1. verifyLabel 四种结果；not_run 有原因、没有有效验证命令，分得开。
 * 3. executorExplanation：失败且自己说没做成、带说明 → 说明；其余 → null。
 */
import { describe, expect, it } from 'vitest';
import { executorExplanation, verifyLabel } from '../../src/index.js';

describe('U5 两句共用的话', () => {
  it('条件 1：verifyLabel 四种结果，not_run 的两种情况分得开', () => {
    expect(verifyLabel({ verify_status: 'passed', verify_output: 'ok' })).toBe('验证通过');
    expect(verifyLabel({ verify_status: 'failed', verify_output: '断言没过' })).toBe('验证没通过');
    expect(verifyLabel({ verify_status: 'not_run', verify_output: '  工作区里没有 pnpm  ' })).toBe(
      '验证没跑',
    );
    expect(verifyLabel({ verify_status: 'not_run', verify_output: '没有有效验证命令' })).toBe(
      '还没有独立验收',
    );
    expect(verifyLabel({ verify_status: 'not_run', verify_output: '  ' })).toBe('还没有独立验收');
    expect(verifyLabel({ verify_status: 'not_run', verify_output: null })).toBe('还没有独立验收');
    expect(verifyLabel({ verify_status: null, verify_output: null })).toBe('还没有独立验收');
    // 只有 not_run 才看输出：别的状态带着输出也不算「验证没跑」
    expect(verifyLabel({ verify_status: null, verify_output: '有一段输出' })).toBe(
      '还没有独立验收',
    );
    expect(verifyLabel({ verify_status: 'unknown', verify_output: '有一段输出' })).toBe(
      '还没有独立验收',
    );
  });

  it('条件 3：失败、自己说没做成、带说明才返回说明；其余是 null，坏 JSON 不抛', () => {
    const report = (summary: string, claimed = false) =>
      JSON.stringify({
        claimedSuccess: claimed,
        summary,
        changedPaths: [],
        testsModified: false,
        raw: '',
      });
    expect(
      executorExplanation({ status: 'failed', executor_report_json: report('  做不到  ') }),
    ).toBe('做不到');
    expect(
      executorExplanation({ status: 'pending_accept', executor_report_json: report('做不到') }),
    ).toBe(null);
    expect(
      executorExplanation({ status: 'failed', executor_report_json: report('做不到', true) }),
    ).toBe(null);
    expect(executorExplanation({ status: 'failed', executor_report_json: report('   ') })).toBe(
      null,
    );
    expect(executorExplanation({ status: 'failed', executor_report_json: null })).toBe(null);
    expect(executorExplanation({ status: 'failed', executor_report_json: '不是 json' })).toBe(null);
    expect(executorExplanation({ status: 'failed', executor_report_json: 'null' })).toBe(null);
    expect(
      executorExplanation({
        status: 'failed',
        executor_report_json: '{"claimedSuccess":false,"summary":12}',
      }),
    ).toBe(null);
    // 报告里没写 claimedSuccess：不算「自己说没做成」
    expect(
      executorExplanation({ status: 'failed', executor_report_json: '{"summary":"做不到"}' }),
    ).toBe(null);
  });
});
