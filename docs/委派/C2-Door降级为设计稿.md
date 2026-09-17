# 委派单 C2：Door 降级为设计稿

任务来源：[三周任务单](../三周任务单.md) C2。大小：**小到中（≤200 行改动，净删除）**。

## 背景（不要跳过）

Door 是「设备能力感知」模块。它的协议设计是认真的，问题是：**从来没有第二台真实设备连上来过**。开发方自查（`REVIEW_PACKET.md` §69.1）判定 P4 出口未达成，§70.2 明确写着「没有第二台真实设备完成配对与任务执行」。

一套只有自己的测试在调用的设备协议，放在 `packages/core/src` 主干里，会不断被写进「已实现」清单。本任务把它降级为设计稿：**代码移出主干，设计保留在文档里，表结构原样留在数据库。**

这不是取消。等日用中真的出现「这台机器跑不动」的时候再接回来，那时才知道它该长什么样。

## 🚫 绝对不许动的东西

**迁移 24 的三张表（`door_devices` / `door_benchmarks` / `door_task_leases`）必须原样保留。**

`packages/core/src/db/migrations.ts` 的顶部注释写着：迁移只能追加，不能修改或删除已有迁移。已经发布的迁移改了，任何已升级过的数据库都会与代码不一致。

你要做的是在迁移 24 的 SQL 注释里**追加一行说明**，告诉后来人这三张表当前没有代码在用：

```
-- 2026-09-17：Door 已降级为设计稿（见 docs/design/door-设备能力感知.md）。
-- 这三张表保留不动（迁移只追加不改写），当前无代码读写。重新启用时复用。
```

除此之外不许碰 `migrations.ts` 的任何一个字符。

## 要改的文件

**移走：**

| 文件 | 怎么改 |
| --- | --- |
| `packages/core/src/door/doorService.ts` | 移动到 `docs/design/door-doorService.ts.txt`（改成 `.txt` 后缀，不参与编译），在文件开头加一段说明：这是设计稿，对应迁移 24 的三张表，重新启用时从这里取。然后删除 `packages/core/src/door/` 目录 |
| `docs/design/door-设备能力感知.md` | 新建。内容 = 从 `docs/history/IXAEON_v0.3_开发计划_Door设备能力感知.md` 里摘出仍然有效的设计原则（低负载、默认关闭、撤权、实测过期、三档能力感知），加上「为什么现在不做」和「重新启用时从哪里接」。**≤60 行，不要复制整份旧计划** |

**拆线（全部删除对应代码）：**

| 文件 | 位置 |
| --- | --- |
| `packages/core/src/index.ts` | `DoorService` 及相关类型的 export（约 187 行附近） |
| `apps/desktop/src/main/appRuntime.ts` | `DoorService` import（27 行）、`door` 字段（89、121 行）、两处 `new DoorService(db)`（174、1113 行） |
| `apps/desktop/src/main/server/localServer.ts` | `DoorService` 类型 import（8 行）、`door?` 依赖（81、112 行）、`/api/door/heartbeat` 与 `/api/door/benchmark` 两个路由（701–760 行附近） |
| `packages/contracts/src/ipc.ts` | `doorHeartbeatSchema`、`doorBenchmarkSchema`，以及 `IxaIpcApi` 里 7 个 Door 方法的类型声明 |
| `apps/desktop/src/main/ipc.ts` | 668–736 行的 7 个 Door 处理器 |
| `apps/desktop/src/preload/index.ts` | 115–122 行的 7 个 Door 桥接 |
| `apps/desktop/src/renderer/src/pages/Settings.tsx` | DoorCard 面板及其调用 |
| `apps/desktop/src/renderer/src/api.ts` | Door 相关的 api 方法（如果有） |

**删除测试与门禁：**

| 文件 | 怎么改 |
| --- | --- |
| `apps/desktop/test/review/review-p4-door-persistence-20260916.test.ts` | 整个文件删除 |
| `apps/desktop/test/review/review-p4-p5-door-models-20260916.test.ts` | 整个文件删除（其中 P5 部分由委派单 C1 一并清掉） |
| `scripts/verify.mjs` | 删除 `review-p4-door-persistence` 和 `review-p4-p5-door-models` 两道门禁 |

## 验收条件（由整合方写定，不得自行修改或增补）

1. `grep -rn "DoorService\|doorHeartbeat\|doorBenchmark\|listDoorDevices\|pairDoorDevice" --include="*.ts" --include="*.tsx" apps packages scripts` 排除 `node_modules`/`dist` 后**零命中**。
2. `git diff packages/core/src/db/migrations.ts` **只包含新增的注释行**，没有任何 SQL 语句被修改或删除。
3. 用当前代码新建一个数据库并跑全部迁移后，`door_devices` / `door_benchmarks` / `door_task_leases` 三张表**依然存在**：
   ```
   SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'door_%'
   ```
   必须返回 3 行。
4. `tsc --noEmit`、`eslint .` 退出码均为 0。
5. `--project unit` 与 `--project integration` 全部通过。integration 的**跳过数不得增加**（当前 12），即不许用 skip 来绕过失败。
6. 桌面应用能正常构建：`node scripts/build.mjs` 退出码 0。
7. `docs/design/door-设备能力感知.md` 存在且 ≤60 行。

## 明确不许做

- **不许删表、不许改迁移 24 的 SQL**。只能追加注释。
- **不许用 skip 代替修复**。测试跳过数不能增加。
- **不许顺手重构 localServer 或 ipc 的其他部分**。只拆 Door 那几处线。
- **不许自己写验收标准**。上面 7 条是全部。

## 交付说明要写什么

分开写：已实现 / 自动化通过 / 未完成。必须贴出验收条件 2 和 3 的实际输出（迁移 diff 与建表查询结果），这两条是本任务的安全底线。
