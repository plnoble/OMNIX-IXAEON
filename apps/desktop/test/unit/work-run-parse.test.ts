// @vitest-environment jsdom
/**
 * 工作记录的 JSON 字段解析（2026-09-18 真机回归）。
 *
 * 真机：唯一一条工作记录的 tests_json 是编码任务执行器写的
 * { verify_status, verify_exit_code }，界面按数组读，`tests.filter is not a function`
 * 让整个项目页崩掉。两种写入方的形状都要认，认不出的不能崩。
 */
import { describe, expect, it } from 'vitest';
import { parseWorkStrings, parseWorkTests } from '../../src/renderer/src/pages/Projects.js';

describe('工作记录解析', () => {
  it('外部编码工具写的数组形状', () => {
    expect(
      parseWorkTests(
        JSON.stringify([
          { name: 'unit', result: 'passed' },
          { name: 'e2e', result: 'failed' },
        ]),
      ),
    ).toEqual([
      { name: 'unit', result: 'passed' },
      { name: 'e2e', result: 'failed' },
    ]);
  });

  it('编码任务执行器写的对象形状（真机那条）', () => {
    expect(
      parseWorkTests(JSON.stringify({ verify_status: 'failed', verify_exit_code: 1 })),
    ).toEqual([{ name: '独立验证（退出码 1）', result: 'failed' }]);
    expect(parseWorkTests(JSON.stringify({ verify_status: null, verify_exit_code: null }))).toEqual(
      [{ name: '独立验证', result: 'not_run' }],
    );
  });

  it('认不出的形状、坏 JSON、空值：当作没有记录，不崩', () => {
    for (const bad of ['null', '"passed"', '42', '{"x":1}', '不是JSON', '', null, undefined]) {
      expect(parseWorkTests(bad), String(bad)).toEqual([]);
    }
    expect(parseWorkTests(JSON.stringify([null, 3, { name: 'x', result: '奇怪' }]))).toEqual([
      { name: 'x', result: 'not_run' },
    ]);
  });

  it('字符串数组字段只留字符串', () => {
    expect(parseWorkStrings(JSON.stringify(['a', 2, null, 'b']))).toEqual(['a', 'b']);
    expect(parseWorkStrings(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseWorkStrings(null)).toEqual([]);
  });
});
