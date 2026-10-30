# K2b 驾驶舱快照（队列、项目、装配与 IPC）交付

- 分支：`dev/K2b`，基于 `dev/K2`（K2a `7b303c4`），K2a 基于 main `4800906`；档位 **B**
- 执行方：dev
- 这是 K2 两支里的第二支。队列里还是第 139 行这一行；第一支的说明见 [K2a](K2a.md)。

## 已实现

`packages/core/src/cockpit/snapshot.ts`（新）：

- **队列**：`git -C <ixaeonRepo> show origin/main:docs/委派/队列.md`（10 秒超时，不 fetch），自己解析「可以领的」主表（行为照 relay 的 `parseMainTable`，core 不 import relay）。状态以「等用户」开头的行 → `attention.queue_user`；只认 origin/main，不读工作区。
- **项目**：`projects` 表按 `status` 分 `active` / `paused` / `archived` 三组，卡片只带 `id`、`name`、`status`、`description`、`currentState`、`updatedAt`。
- **装配**：`buildCockpitSnapshot(db, { relayDir, ixaeonRepo, now? })`，relay 部分调 K2a 的 `readRelaySnapshot`；`ixaeonRepo` 只认参数（空串 = 没设 `cockpit.ixaeon_repo`，queue 记 `missing`），`relayDir` 空串时用 `IXAEON_RELAY_DIR`、默认 `~/.ixaeon/relay`。
- **`relay_stale`**：最后一棒结束超过 2 小时、没有角色额度暂停中、队列里至少一行以「待领」或「进行中（」开头（不看依赖），三条同时成立才把 relay 记 `stale` 并进 `attention`。
- 任何文件不存在/解析失败 → 对应来源 `missing` / `error` 并写 note，其他来源照常，不抛错。

其余接线：

- `packages/contracts/src/ipc.ts`：`IxaIpcApi.getCockpitSnapshot(): Promise<CockpitSnapshot>`。
- `apps/desktop/src/main/ipc.ts`：注册 `getCockpitSnapshot`，从设置项 `cockpit.ixaeon_repo` 取仓库路径（没设传空串），relayDir 留空让 core 走环境变量/默认目录。
- `apps/desktop/src/preload/index.ts`：暴露 `window.ixaeon.getCockpitSnapshot`。
- `packages/core/src/index.ts`：导出 `buildCockpitSnapshot`。
- `scripts/real/cockpit-snapshot.ts`（新）：真机检查脚本，只输出统计数字（见下）。

改动文件与行数（源码 + 真机脚本，`git diff --stat dev/K2...HEAD -- apps packages scripts`；交付说明不计）：

```
 apps/desktop/src/main/ipc.ts          |   8 ++
 apps/desktop/src/preload/index.ts     |   2 +
 packages/contracts/src/ipc.ts         |   3 +
 packages/core/src/cockpit/snapshot.ts | 174 ++++++++++++++++++++++++++++++++++
 packages/core/src/index.ts            |   1 +
 scripts/real/cockpit-snapshot.ts      |  55 +++++++++++
 6 files changed, 243 insertions(+)
```

其中**源码 188 行**（`apps/*/src`、`packages/*/src` 的 8 + 2 + 3 + 174 + 1）；真机脚本 55 行不计入 300 行。

与规格的一处说明：规格「契约」把 `relayDir` 的默认值和 `IXAEON_RELAY_DIR` 覆盖写在 `buildCockpitSnapshot` 下面，整合方审测试时又定了「`ixaeonRepo` 只认参数、设置项是 IPC 那一层的事」。实现照这两条：`relayDir` 的默认/环境变量在 `buildCockpitSnapshot` 里，`ixaeonRepo` 只认参数，IPC 层读设置项后传进来。

## 验收测试（v2 规格任务）

K2 锁定的两份测试、19 条，本支全过：

| 文件 | it | 规格条件 |
| ---- | --- | -------- |
| `packages/core/test/acceptance/k2-cockpit-snapshot.test.ts` | 17 | 1–7、9–11 及整合方补的 7 条 |
| `apps/desktop/test/acceptance/k2-cockpit-ipc.test.ts` | 2 | 8 及「没设设置项 → queue missing」 |

没有改锁定测试；`docs/委派/锁定验收.json` 里 K2 的指纹没动。

## 自动化通过

- `node scripts/acceptance.mjs run K2`（`dev/K2b`）：**19 passed (19)**，`Test Files 2 passed (2)`，退出码 0。原样输出在 `.logs/k2b-acceptance.txt`。
- K2a 单独跑是 19 failed（`buildCockpitSnapshot` 在第二支）——拆支的中间状态，输出在 `dev/K2` 的 `.logs/k2a-acceptance.txt`。
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：退出码 0。
- `node scripts/typecheck-acceptance.mjs`：退出码 0。
- eslint、prettier：改到的源码、真机脚本都过。
- `node scripts/verify.mjs`：**全部通过，退出码 0**。lint、format:check、local-user、typecheck、typecheck-acceptance、build、unit（69 条）、integration（483 passed / 17 skipped）、acceptance-lock（83 个任务 160 个锁定测试没被改）、acceptance（1195 条）、各套 review 与四套真实 Electron 界面复审都过。日志在 `.logs/verify2.txt`。

## 真机通过

`node scripts/real/run-batch.mjs scripts/real/cockpit-snapshot.ts` 原样输出（对本机真实的 relay 数据目录 `~/.ixaeon/relay` 和 IXAEON 仓库的 origin/main 构建快照；项目分组用临时空库 + 3 个合成项目，不碰用户应用库；脚本只打数字，不打路径和内容）：

```
===== scripts/real/cockpit-snapshot.ts =====
[runner] 数据目录核对：起应用=否，临时目录当参数传（mkdtempSync=有）
来源状态：relay=ok queue=ok projects=ok
running=2 attention=1
recent=20 today.finishedTurns=4
projects：active=1 paused=1 archived=1
RESULT K2 relay=ok queue=ok projects=ok running=2 attention=1 recent=20 active=1 paused=1 archived=1
[runner] cockpit-snapshot.ts 退出码=0｜RESULT K2 relay=ok queue=ok projects=ok running=2 attention=1 recent=20 active=1 paused=1 archived=1
```

真实 relay 目录这次 `relay=ok`、`attention=1`（一条要提醒的），`recent` 到 20 条的上限，说明读真数据没有解析失败。真机没有输出任何一行的文本、没有打印本机账户名。

## Codex 审查（A 档）

不适用（B 档）。按 AGENTS.md，第二支用 `node scripts/codex-review.mjs K2b --base dev/K2` 只看本支自己的改动（或由整合方直接复审）。本支没有改规格、没有改锁定测试、没有改迁移。

## 已知缺口

- **要两支一起合**：先 `dev/K2`（K2a，298 行源码），再 `dev/K2b`（本支，188 行源码）。只合 K2a 没有 `buildCockpitSnapshot`，19 条验收红；只合 K2b 会缺 relay 模块和 contracts 类型。
- **`sources.projects.lastEventAt`** 取库里最大的 `updated_at`（没有项目时为 null）；规格没写这一项，取的是「最近一次项目变动」。
- **`sources.queue.readAt`** 是构建快照的时间；队列本身没有事件时间，`lastEventAt` 为 null。
- **真机脚本的项目分组是合成的**（临时空库 + 3 个项目），只验证分组计数；真实项目数据没有读，避免碰用户应用库。
- **没有 HTTP 接口**（规格明说 K2 不加；K8 用时再加），`localServer.ts` 没动。
- 真机输出里 `attention=1` 是哪一类没有打印（规格只要求条数，避免输出文本内容）；要查具体是哪条，看 K3 的页面或 `relay status`。
- 本支新增的 `getCockpitSnapshot` 目前没有界面调用方（K3 才用）；`typecheck` 保证形状对得上。

## 用户接受

未发生（用户用过并认可之后才写）。