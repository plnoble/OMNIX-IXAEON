import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CodingTask } from '@ixaeon/contracts';
import type { CodingExecutor, ExecutorReport, ExecutorRunOptions } from '@ixaeon/core';

/**
 * D7b：按设置选执行器。以后加 Claude Code 或别的 agent，是给 ExecutorPlan
 * 加一种，不是再改一遍派发。
 */
export type ExecutorPlan =
  | { use: 'codex' }
  | { use: 'model'; executor: CodingExecutor }
  | { use: 'none'; missing: 'model_name' | 'model_key' };

export type ExecutorGap = Extract<ExecutorPlan, { use: 'none' }>['missing'];

/** 缺什么、去哪补。回报、任务页的报错与顶部说明都用这一句，只留一份。 */
export function executorGapText(missing: ExecutorGap): string {
  return missing === 'model_name'
    ? '没有选「我的模型」用的模型：去设置的「编码任务交给谁」里选一个，选好后在任务页点派发。'
    : '没有配置「我的模型」用的 API Key：去设置的「模型接入」里填上，再来任务页点派发。';
}

/**
 * 包在现有执行器外面的一层：每次 run / 读 name 时都重新问一次 plan——
 * 改了设置不用重启，跑到一半改设置这一单还按开工时的那次算（编排层在开工时
 * 读一次名字并写库）。
 */
export class ConfiguredCodingExecutor implements CodingExecutor {
  constructor(
    private readonly codex: CodingExecutor,
    private readonly plan: () => ExecutorPlan,
  ) {}

  /** 每次现读：plan 是 model 就给模型执行器的名字，其余给 codex 的名字。 */
  get name(): string {
    const current = this.plan();
    return current.use === 'model' ? current.executor.name : this.codex.name;
  }

  async run(
    task: CodingTask,
    workspace: string,
    signal: AbortSignal,
    options?: ExecutorRunOptions,
  ): Promise<ExecutorReport> {
    // 第一个 await 之前取一次 plan：这一次派发用哪个执行器就钉死了
    const current = this.plan();
    if (current.use === 'none') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, executorGapText(current.missing));
    }
    // D5a：只读范围原样传下去（交给模型、交给 Codex 都传）
    return current.use === 'model'
      ? current.executor.run(task, workspace, signal, options)
      : this.codex.run(task, workspace, signal, options);
  }
}
