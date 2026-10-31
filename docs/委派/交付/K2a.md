# K2a 驾驶舱快照（relay 部分）交付

- 分支：`dev/K2`，基于 main `4800906`；档位 **B**
- 执行方：dev
- 这是 K2 两支里的第一支。规格「大小」写了 ≤300 行源码，超了就拆 K2a（relay 部分）/ K2b（队列和项目部分 + IPC）；实现合计 486 行（K2a 298 + K2b 188），照规格拆。队列里还是第 139 行这一行。

## 已实现

`packages/core/src/cockpit/relay.ts`（新）：relay 数据目录的只读解析。读 `lock.json`、`ledger.jsonl`、`state.json`，`turns/` 只看目录名和文件的修改时间；不读 `config.json`、`feishu.json`、`inbox.jsonl`，也不读 `turns/` 下任何文件的内容。产出：来源健康（含 `readAt` / `lastEventAt` / note）、`relay_down` / `turn_unfinished` / `relay_stopped` / `paused_role` / 在跑的 relay 和第几棒、`recent`（最多 20、最新在前，飞书回复棒只写「处理了你在飞书里的回复」）、`today.finishedTurns`（按北京时间的当天数）。pid 判活照 relay 的 `pidAlive`（EPERM 也算活着）。

`packages/contracts/src/cockpit.ts`（新）：规格契约里的 zod 类型（`SourceHealth` / `AttentionItem` / `RunningItem` / `RecentEvent` / `ProjectCard` / `CockpitSnapshot`）；`packages/contracts/src/index.ts` 导出。

`packages/core/src/index.ts`：导出 `readRelaySnapshot`。

改动文件与行数（`git diff --stat 4800906...dev/K2`，含本交付说明）：

```
 docs/委派/交付/K2a.md              |  57 +++++
 packages/contracts/src/cockpit.ts  |  60 +++++
 packages/contracts/src/index.ts    |   1 +
 packages/core/src/cockpit/relay.ts | 236 +++++++++++++++
 packages/core/src/index.ts         |   1 +
 5 files changed, 355 insertions(+)
```

其中**源码 298 行**（`packages/*/src` 的 60 + 1 + 236 + 1；交付说明 57 行不计入 300 行）。

没有 `buildCockpitSnapshot`：它是 K2b 那支的装配函数（本支只放 relay 读取）。`relay_stale` 的三条判断也在 K2b（要读队列，不知道有没有待领/进行中的活）。

## 验收测试（v2 规格任务）

K2 锁定的两份测试、19 条：`packages/core/test/acceptance/k2-cockpit-snapshot.test.ts`（17 条）和 `apps/desktop/test/acceptance/k2-cockpit-ipc.test.ts`（2 条）。本支只做 relay 部分，测试引的 `buildCockpitSnapshot` / `getCockpitSnapshot` 在 K2b，所以**本支 19 条全红**（红的原因是「还没实现」，不是测试坏了）。完整的 19 条在 `dev/K2b` 上全过，见 [K2b 交付说明](K2b.md)。

## 自动化通过

- `node scripts/acceptance.mjs run K2`（`dev/K2`）：**19 failed (19)**。原样输出在 `.logs/k2a-acceptance.txt`，红的原因都是 `buildCockpitSnapshot 还没实现…` / `没有注册 IPC：getCockpitSnapshot`。这是拆支的中间状态：本支单独不满足任务验收，K2b 才满足。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：退出码 0。
- eslint、prettier：本支改的文件都过。
- `node scripts/verify.mjs`：**没在本支单独跑**；在 K2b（含本支）上跑，结果见 [K2b 交付说明](K2b.md)。

## 真机通过

**没跑。** 本支没有 `buildCockpitSnapshot`，真机脚本 `scripts/real/cockpit-snapshot.ts` 在 K2b；在 K2b 上跑过（输出见 K2b 交付说明）。

## Codex 审查（A 档）

不适用（B 档）。由整合方复审；拆成两支时按 AGENTS.md，第二支基于本支、只看第二支自己的改动。

## 已知缺口

- **第一支单独不合入就没有意义**：它只提供 relay 读取模块和契约类型，`buildCockpitSnapshot` 和 19 条验收在 K2b。整合方要并的是两支（先 K2a、再 K2b），并完才算 K2 做完。
- 拆支是规格写的「超了就拆」；测试是整合方按一整单锁的，所以本支的 19 条只能等 K2b。若整合方认为不该拆、或希望换一种拆法，按流水线转回整合方定，本支没改任何锁定的测试和规格。
- 本支没有新增网络访问、没有加 HTTP 接口、没有改迁移。

## 用户接受

未发生（用户用过并认可之后才写）。