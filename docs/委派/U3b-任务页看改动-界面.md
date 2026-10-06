# U3b（U3 拆出的第二支：IPC 接线 + 界面 + 真机检查）

U3 变化的全部要求、契约、约束、验收条件见 **《U3-任务页看改动.md》**——本支是规格第 7 行说的拆分：第一支 `prep/U3` 先交核心层（条件 1–10、13），本支交 IPC（条件 11）与界面（条件 12）。

本支验收只针对条件 11、12（其余在第一支）：`apps/desktop/test/acceptance/u3-ipc.test.ts`（2 条）与 `apps/desktop/test/acceptance/u3-tasks-page.test.ts`（4 条），已由 `acceptance.mjs lock U3b` 锁定。真机检查即规格「真机检查」一节（`scripts/real/u3-task-changes.mjs`）。