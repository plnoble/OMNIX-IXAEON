# 委派单 C1：删除 ModelPool 与 RoleCoordinator

任务来源：[三周任务单](../三周任务单.md) C1。大小：**小（≤100 行改动）**。

## 背景（不要跳过）

这两个类是 2026-09-16「一天完成 P2–P6」批次的产物，经核查为空壳：

- `ModelPool.fromConfig()` 里的 `contextWindow: 64_000`、`costPer1k: 0.002`、`latencyMs: 800` 全是硬编码猜测值，而计划要求的是实测值。`selectModel()` 的「多维决策」= 按这个编出来的数字排序。
- `appRuntime.selectModelResource()` **全仓库只出现 1 次——它自己的定义**，没有任何调用方。它从写出来那天起就是死代码。
- `RoleCoordinator` 是 124 行内存 switch，重启归零。

**关于 RoleCoordinator 的守卫，有个事实你必须知道，否则会误以为删掉它会丢安全性：**

`skills.ts:496` 调用时写死了 `role: 'auditor'`：

```ts
this.roleGuard.checkPermission({ role: 'auditor', action: 'approve_upgrade' });
```

`auditor` + `approve_upgrade` 在角色矩阵里永远通过。所以「coder 不能自批升级」这条规则在生产路径上**从未被触发过**——只有测试直接传 `role: 'coder'` 时才会走到。这个守卫实际只剩一个 10,000 步 / $1,000 的预算上限，对单次点击批准毫无意义。

**删掉它不丢任何真实约束。不要发明一个替代品。**

## 要改的文件

| 文件 | 怎么改 |
| --- | --- |
| `packages/core/src/models/modelPool.ts` | 整个文件删除（连同 `models/` 目录，如果空了） |
| `packages/core/src/orchestration/roleCoordinator.ts` | 整个文件删除 |
| `packages/core/src/index.ts` | 删除这两个模块的全部 export（约在 196–215 行） |
| `packages/core/src/runtime/skills.ts` | 删除第 4 行的 `import type { RoleActionRequest }`；删除构造函数第三个参数 `roleGuard`；删除 `approve()` 里 494–497 行的守卫调用与注释 |
| `apps/desktop/src/main/appRuntime.ts` | 删除 `ModelPool` / `RoleCoordinator` 两个 import；删除 `selectModelResource()` 整个方法；删除 `skillRoleGuard` 字段；`approveSkillCandidate` 里 `new SkillCandidateStore(this.db, this.skillRoleGuard)` 改为 `new SkillCandidateStore(this.db)` |
| `apps/desktop/test/review/review-p4-p5-door-models-20260916.test.ts` | **不要改这个文件**，见 C2 |
| `apps/desktop/test/review/review-p6-governance-lifecycle-20260916.test.ts` | 整个文件删除 |
| `scripts/verify.mjs` | 删除 `review-p6-governance-lifecycle` 那一道门禁 |

## 验收条件（由整合方写定，不得自行修改或增补）

1. `grep -rn "ModelPool\|RoleCoordinator\|selectModelResource\|RoleActionRequest" --include="*.ts" --include="*.tsx" apps packages scripts` 在排除 `node_modules` 和 `dist` 后**零命中**。
2. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 退出码 0。
3. `node node_modules/eslint/bin/eslint.js .` 退出码 0。
4. `node node_modules/vitest/vitest.mjs run --project unit` 与 `--project integration` 全部通过，**通过数不得比改动前少**（改动前：unit 23，integration 285 通过 + 12 跳过）。
5. `SkillCandidateStore.approve()` 的既有业务约束一条不少：`status !== 'evaluated'` 拒绝、版本不匹配拒绝、空对照（`eval_before` / `eval_after` 为空）拒绝。用现有测试证明，不要新写测试。
6. `git diff --stat` 显示**净删除**。本任务不应新增任何生产代码。

## 明确不许做

- **不许发明替代品**：不要用「更轻量的权限检查」「简化版模型选择」之类的东西补位。这个任务是删除，不是重构。
- **不许动数据库迁移**：迁移只能追加不能改写。本任务不涉及任何迁移。
- **不许顺手改别的**：看到其他可疑代码，写在交付说明里，不要动手。
- **不许自己写验收标准**：上面 6 条是全部，做不到就如实说做不到。

## 交付说明要写什么

分开写清楚：已实现 / 自动化通过 / 未完成。附 `git diff --stat` 与四条命令的实际输出。不要写「全部完成」这种总结句。
