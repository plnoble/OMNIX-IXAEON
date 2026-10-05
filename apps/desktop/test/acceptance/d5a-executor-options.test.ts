/**
 * D5a 验收（桌面端的一小块，整合方写死）。规格：docs/委派/D5a-验收先行-先写测试再写实现.md 契约 1：
 * 「ConfiguredCodingExecutor（桌面端）把 options 原样传下去」。
 *
 * 单独钉住是因为少了这一步，核心层的验收照样全绿，真用起来却是坏的：交给「我的模型」时，
 * 写测试那一步看不到项目里的文件（能改的范围只剩测试目录），写实现那一步看不到测试。
 *
 * `ACCEPTANCE_DIR` 与 `ExecutorRunOptions` 从 `@ixaeon/core` 引入：核心包的出口要带上它们。
 */
import { describe, expect, it } from 'vitest';
import type { CodingTask } from '@ixaeon/contracts';
import {
  ACCEPTANCE_DIR,
  type CodingExecutor,
  type ExecutorReport,
  type ExecutorRunOptions,
} from '@ixaeon/core';
import { ConfiguredCodingExecutor, type ExecutorPlan } from '../../src/main/codingExecutor.js';

const REPORT: ExecutorReport = {
  claimedSuccess: true,
  summary: '',
  changedPaths: [],
  testsModified: false,
  raw: '',
};

/** 只记下自己收到了什么的执行器。 */
function recorder(name: string): { executor: CodingExecutor; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    executor: {
      name,
      async run(...args) {
        calls.push(args);
        return REPORT;
      },
    },
  };
}

const task = { id: 't1', goal: '合成的任务' } as CodingTask;
const options: ExecutorRunOptions = { readScope: ['src', `${ACCEPTANCE_DIR}/abcd1234`] };

describe('契约 1：ConfiguredCodingExecutor 把只读范围原样传下去', () => {
  it('核心包的出口带着测试目录的名字', () => {
    expect(ACCEPTANCE_DIR).toBe('ixaeon-acceptance');
  });

  it('交给我的模型：模型执行器收到同样的四样东西', async () => {
    const codex = recorder('codex-cli');
    const model = recorder('model:m');
    const plan = (): ExecutorPlan => ({ use: 'model', executor: model.executor });
    const signal = new AbortController().signal;
    await new ConfiguredCodingExecutor(codex.executor, plan).run(task, 'ws', signal, options);
    expect(codex.calls).toHaveLength(0);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]![0]).toBe(task);
    expect(model.calls[0]![1]).toBe('ws');
    expect(model.calls[0]![2]).toBe(signal);
    expect(model.calls[0]![3]).toEqual({ readScope: ['src', 'ixaeon-acceptance/abcd1234'] });
  });

  it('交给 Codex：一样传下去（Codex 用不用是它的事）', async () => {
    const codex = recorder('codex-cli');
    const plan = (): ExecutorPlan => ({ use: 'codex' });
    const signal = new AbortController().signal;
    await new ConfiguredCodingExecutor(codex.executor, plan).run(task, 'ws', signal, options);
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]![3]).toEqual({ readScope: ['src', 'ixaeon-acceptance/abcd1234'] });
  });

  it('不传只读范围：下面的执行器也收不到', async () => {
    const codex = recorder('codex-cli');
    const model = recorder('model:m');
    const plan = (): ExecutorPlan => ({ use: 'model', executor: model.executor });
    await new ConfiguredCodingExecutor(codex.executor, plan).run(
      task,
      'ws',
      new AbortController().signal,
    );
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]![3]).toBeUndefined();
  });
});
