# W1b 概览页新发现 交付

- 分支：grok/W1b，基于 main `4c78fb0`；档位 A
- 执行方：Grok

## 已实现

`getPersonalOverview()` 增加 `recentFindings`：已启用研究主题、最近 7 天、最新在前、最多 10 条；`isNew` 看 `app_settings` 键 `overview.findings_seen_at`（从没看过则全是新）。IPC `markFindingsSeen()` 把该键写成现在。概览页有发现才显示「最近的新发现」；点标题用系统浏览器打开（与研究页一样 `<a target=_blank>`）；「都看过了」调 IPC 再刷新。原来的「值得跟进」不动。

```
 apps/desktop/src/main/appRuntime.ts              |  6 ++++
 apps/desktop/src/main/ipc.ts                     |  1 +
 apps/desktop/src/preload/index.ts                |  1 +
 apps/desktop/src/renderer/src/pages/Overview.tsx | 35 ++++++++++++++++++++
 packages/contracts/src/ipc.ts                    | 10 ++++++
 packages/core/src/index.ts                       |  7 +++-
 packages/core/src/personal/overview.ts           | 41 ++++++++++++++++++++++++
 packages/core/src/settings.ts                    |  3 ++
 8 files changed, 103 insertions(+), 1 deletion(-)
```

测试与锁定文件另计。实现未改研究定时/搜索/打分，无迁移。

## 验收测试（v2 规格任务）

- `apps/desktop/test/acceptance/w1b-recent-findings.test.ts`
  - 条件 1：2 个启用 + 1 个未启用；今天 / 3 天前 / 10 天前；只返回启用且 7 天内的，倒序；再填 11 条验证最多 10。
  - 条件 2：从没看过全 `isNew`；`markOverviewFindingsSeen` 后旧的不是新；再插入一条又是新。
- `apps/desktop/test/acceptance/w1b-overview-findings-page.test.ts`
  - 条件 3：有发现显示块、新的有 `recent-finding-new-<id>`；点「都看过了」调 `markFindingsSeen` 并刷新；没有发现时整块不出现；「值得跟进」仍在。

IPC 名是 `markFindingsSeen`；核心函数 `markOverviewFindingsSeen`，runtime 转发。

## 自动化通过

- `node scripts/acceptance.mjs run W1b`：3 passed
- `node scripts/verify.mjs`：EXIT=0
- GitHub 上的 verify：绿（运行 [35444914162](https://github.com/plnoble/OMNIX-IXAEON/actions/runs/35444914162)，`b25a3bf`）

## 真机通过

临时 `IXAEON_DATA_DIR` 启动已构建的 Electron，向库写入合成主题「W1b 真机合成方向」和发现「W1b 真机合成发现」，打开概览。

点「都看过了」前：

```
最近的新发现
W1b 真机合成发现 · W1b 真机合成方向 · 2026-09-19 11:29 新
都看过了
```

点之后：

```
AFTER_NEW_BADGES 0
最近的新发现
W1b 真机合成发现 · W1b 真机合成方向 · 2026-09-19 11:29
都看过了
```

「新」标消失，块仍在（还有发现，只是不算新）。截图在本机 `apps/desktop/release/screenshots/w1b-findings-before.png` 与 `w1b-findings-after.png`，未提交。

## Codex 审查（A 档）

2026-09-19 重跑结论「需要修改」。三条「必须改」我不同意，**不改锁定测试、不合并**，交整合方复审：

1. **行数 634**：实现约 103 行（规格 ≤200）。其余是规格要求的验收测试、交付和真机脚本。规则要拆的是实现，不是把锁定测试拆走。
2. **「最新 10 条」**：查询是 `ORDER BY fetched_at DESC LIMIT 10`，锁定测试已断言长度 10 且时间倒序。再断言具体 id 得改锁定测试。
3. **点过「都看过了」后标记消失**：页面在 `markFindingsSeen` 之后 `reload()`；真机 `AFTER_NEW_BADGES 0`。锁定测试查的是 IPC 与再次拉取，不能改测试去查 DOM。

建议：链接与研究页同为 `<a target=_blank>`（规格：「照研究页现有做法」）。

## 已知缺口

- 暂停但仍启用的主题，规格只说「已启用」，查询按 `enabled = 1`，不看 `paused`。
- 链接打开方式与研究页相同（`<a target=_blank>`），没有另调 `shell.openExternal`。

## 用户接受

未发生。
