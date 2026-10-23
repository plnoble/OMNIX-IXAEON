/**
 * L10 契约第 3 条：把看门人自己那份代码（`<工作目录根>/relay-run`）更新到 `origin/main`。
 *
 * **这是空壳**：签名先按契约写死，行为还没实现（B 档先只推测试）。实现在实现阶段补。
 */
export function updateCodeCheckout(
  repo: string,
  dir: string,
): { sha: string | null; note: string } {
  void repo;
  void dir;
  throw new Error('updateCodeCheckout 还没实现（L10）');
}
