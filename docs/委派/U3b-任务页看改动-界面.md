# U3b（U3 拆出的第二支：IPC 接线 + 界面 + 真机检查）

U3 变化的全部要求、契约、约束、验收条件见 **《U3-任务页看改动.md》**——本支是规格第 7 行说的拆分：第一支 `prep/U3` 先交核心层（条件 1–10、13），本支交 IPC（条件 11）与界面（条件 12）。本支范围内的规格原文摘录如下（供审查对照）：

- **契约 6（IPC）**：`getCodingTaskChanges(id: string): Promise<TaskChanges>`。三处照现有的写法加：`packages/contracts/src/ipc.ts`、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`。任务不存在照 `store.get` 现有的方式报错。
- **契约 7（界面）**：执行报告里 `changedPaths` 不是空的任务，卡片上显示「改了 N 个文件」和一个按钮「看改动」（`data-testid="task-changes-toggle-<任务号>"`）。点了调 IPC，在卡片里（`data-testid="task-changes-<任务号>"`）列出每个文件：路径、种类（新增 / 修改 / 删除 / 没有变化 / 看不了）、note、差异。差异用 `<pre>`，`+` 行和 `-` 行颜色不同。`total` 比列出来的多时写一句「共 N 个，只列了前 50 个」。按钮变成「收起」，再点收起。再点开重新读一次。读取出错：错误显示在这张卡片里，不用整页顶上的报错条。`changedPaths` 是空的、或者没有执行报告的任务：不显示这一行和按钮。
- **验收条件 11**：IPC：`registerIpc` 注册了 `getCodingTaskChanges`，调它得到的和 `readTaskChanges` 一样；不存在的任务报错。预加载和接口类型也接上（少接一处，类型检查过不了）。
- **验收条件 12**：界面：有改动的任务显示「改了 N 个文件」和「看改动」；点开列出文件、种类、note、差异；再点收起；读取出错显示在卡片里；没有改动的任务不显示。
- **真机检查**（`scripts/real/u3-task-changes.mjs`）：照 `u2-tasks-page-live.mjs` 的做法——建任务（替身执行器改写 note.txt）等它做完 → 任务页点「看改动」打印清单、种类、+/- 行数 → 点「接受」再打印（分支建好没合并，差异应当还在）→ 合并分支再打印（应当是「没有变化」）。结果不对以非零码退出。

本支验收测试：`apps/desktop/test/acceptance/u3-ipc.test.ts`（2 条对条件 11）与 `apps/desktop/test/acceptance/u3-tasks-page.test.ts`（5 条对条件 12，含收起/再展开的请求竞态），已由 `acceptance.mjs lock U3b` 锁定。