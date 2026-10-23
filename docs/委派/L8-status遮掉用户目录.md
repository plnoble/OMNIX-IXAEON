# 委派单 L8：`relay status` 打印路径时遮掉用户目录

档位：**A**（小功能）。大小：很小。依赖：无。来源：整合方 2026-10-23。这是接力调度器在用户电脑上跑的**第一棒真活**，故意挑了一件很小的。

## 要什么

`node packages/relay/bin/relay.mjs status` 现在会把数据目录原样打出来，比如 `C:\Users\<账户名>\AppData\Local\IXAEON\relay`。这串常被贴进交付说明，而仓库是公开的，账户名不能进去。

改成：`relay status` 打印的所有内容里，**用户目录**（`os.homedir()` 的值）换成 `~`。只改打印，不改 `state.json`、`ledger.jsonl` 里存的东西。

## 约束

- 只改 `packages/relay/bin/relay-main.ts` 里 `status` 那一段（加一个小函数也行）。
- 不改已锁定的验收测试。

## 验收

- 新加测试 `packages/relay/test/acceptance/l8-status-mask.test.ts`：数据目录用 `IXAEON_RELAY_DIR` 指到用户目录下面的一个临时目录（`os.homedir()` 底下 `mkdtemp`），跑 `relay status`，输出里没有用户目录原文、有 `~`；收尾删掉那个临时目录。用 `node scripts/acceptance.mjs lock L8 …` 登记。
- `node scripts/verify.mjs` 全过；`node scripts/codex-review.mjs L8`；照 AGENTS.md 合并。
