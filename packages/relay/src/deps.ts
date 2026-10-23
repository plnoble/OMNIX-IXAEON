/**
 * L10 契约第 4 条：开棒前装好依赖（`pnpm-lock.yaml` 变了才装）。
 *
 * **这是空壳**：签名先按契约写死，行为还没实现（B 档先只推测试）。实现在实现阶段补。
 */
export function ensureDeps(dir: string, install?: string[]): 'ok' | 'skipped' | 'failed' {
  void dir;
  void install;
  throw new Error('ensureDeps 还没实现（L10）');
}
