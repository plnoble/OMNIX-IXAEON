/**
 * L3 验收测试（一）：事件 → 发出去的那段文字（规格条件 1，对应规格第 2 条）。
 *
 * 逐条对应：五种事件各一条，`formatEvent` 的结果**逐字**对（含可选字段有 / 没有两种、
 * `done` 为空写「无」、`until` 换成北京时间的写法 `10月21日 04:00`）；第一行固定是「【IXAEON 接力】」。
 *
 * 纯函数，不连网、不调模型。
 */
import { describe, expect, it } from 'vitest';
import { formatEvent, type RelayEvent } from '../../src/notify/feishu.js';

describe('条件 1：五种事件的文字逐字对', () => {
  it('stopped：带 taskId 时接一行「第 <taskId> 行：<task>」', () => {
    expect(
      formatEvent({
        kind: 'stopped',
        reason: '开发这一棒并了 B 档',
        taskId: '59',
        task: 'L0b 补完三个命令行的实验',
      }),
    ).toBe(
      [
        '【IXAEON 接力】',
        '停下来了：开发这一棒并了 B 档。',
        '第 59 行：L0b 补完三个命令行的实验',
      ].join('\n'),
    );
  });

  it('stopped：没有 taskId 时不写那一行', () => {
    expect(formatEvent({ kind: 'stopped', reason: '出错退出' })).toBe(
      ['【IXAEON 接力】', '停下来了：出错退出。'].join('\n'),
    );
  });

  it('needs-user：序号、任务、状态都带引号', () => {
    expect(
      formatEvent({
        kind: 'needs-user',
        taskId: '61',
        task: 'Q2 治偶发失败的测试',
        status: '待审（Codex 额度）',
      }),
    ).toBe(
      [
        '【IXAEON 接力】',
        '要你拍板：第 61 行「Q2 治偶发失败的测试」现在是「待审（Codex 额度）」。',
      ].join('\n'),
    );
  });

  it('paused：统筹 / 开发两种角色，until 换成北京时间的写法', () => {
    const until = '2026-10-20T20:00:00.000Z'; // 北京时间 10月21日 04:00
    expect(formatEvent({ kind: 'paused', role: 'integrator', until })).toBe(
      ['【IXAEON 接力】', '统筹撞上额度，歇到 10月21日 04:00。'].join('\n'),
    );
    expect(formatEvent({ kind: 'paused', role: 'developer', until })).toBe(
      ['【IXAEON 接力】', '开发撞上额度，歇到 10月21日 04:00。'].join('\n'),
    );
  });

  it('paused：北京时间跨小时、分钟补零', () => {
    expect(
      formatEvent({ kind: 'paused', role: 'developer', until: '2026-10-20T16:05:00.000Z' }),
    ).toBe(['【IXAEON 接力】', '开发撞上额度，歇到 10月21日 00:05。'].join('\n'));
  });

  it('idle：两种 why 各一句', () => {
    expect(formatEvent({ kind: 'idle', why: 'queue-empty' })).toBe(
      ['【IXAEON 接力】', '队列空了，等你排新活。'].join('\n'),
    );
    expect(formatEvent({ kind: 'idle', why: 'all-blocked' })).toBe(
      ['【IXAEON 接力】', '剩下的都被依赖或暂停挡着，等你看一眼。'].join('\n'),
    );
  });

  it('daily：完成的行用「、」连起来；有 costUsd 时再接一行（保留两位）', () => {
    expect(
      formatEvent({
        kind: 'daily',
        date: '10月20日',
        turns: 12,
        done: ['L0b 补完实验', 'D2c 新版沙箱实验'],
        costUsd: 3.4567,
      }),
    ).toBe(
      [
        '【IXAEON 接力】',
        '10月20日 日报：跑了 12 棒，完成 L0b 补完实验、D2c 新版沙箱实验。',
        'Claude 用量折合约 3.46 美元',
      ].join('\n'),
    );
  });

  it('daily：一个都没完成写「无」；没有 costUsd 时不写那一行', () => {
    expect(formatEvent({ kind: 'daily', date: '10月20日', turns: 0, done: [] })).toBe(
      ['【IXAEON 接力】', '10月20日 日报：跑了 0 棒，完成 无。'].join('\n'),
    );
  });

  it('五种事件的第一行都是「【IXAEON 接力】」', () => {
    const events: RelayEvent[] = [
      { kind: 'stopped', reason: 'x' },
      { kind: 'needs-user', taskId: '1', task: 't', status: 's' },
      { kind: 'paused', role: 'developer', until: '2026-10-20T20:00:00.000Z' },
      { kind: 'idle', why: 'queue-empty' },
      { kind: 'daily', date: '10月20日', turns: 1, done: ['a'] },
    ];
    for (const e of events) {
      expect(formatEvent(e).split('\n')[0]).toBe('【IXAEON 接力】');
    }
  });
});
