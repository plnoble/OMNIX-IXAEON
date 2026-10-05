import { ErrorCodes, IxaError } from '@ixaeon/contracts';
import type { CodingTask } from '@ixaeon/contracts';
import type { CodingExecutor, ExecutorReport } from '@ixaeon/core';

/**
 * D7b：按设置选执行器。以后加 Claude Code 或别的 agent，是给 ExecutorPlan
 * 加一种，不是再改一遍派发。
 */
export type ExecutorPlan =
  | { use: 'codex' }
  | { use: 'model'; executor: CodingExecutor }
  | { use: 'none'; missing: 'model_name' | 'model_key' };

const MISSING_TEXT: Record<'model_name' | 'model_key', string> = {
  model_name: '没有选编码任务的模型：去设置的「编码任务交给谁」里选一个，选好后在任务页点派发。',
  model_key: '没有配置 API Key：去设置的「模型接入」里填上，再来任务页点派发。',
};

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

  async run(task: CodingTask, workspace: string, signal: AbortSignal): Promise<ExecutorReport> {
    // 第一个 await 之前取一次 plan：这一次派发用哪个执行器就钉死了
    const current = this.plan();
    if (current.use === 'none') {
      throw new IxaError(ErrorCodes.VALIDATION_FAILED, MISSING_TEXT[current.missing]);
    }
    return current.use === 'model'
      ? current.executor.run(task, workspace, signal)
      : this.codex.run(task, workspace, signal);
  }
}
