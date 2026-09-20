# W1b 概览页新发现 交付

- 分支：grok/W1b，基于 main `0fda763`；档位 A
- 执行方：Grok
- 历史：2026-09-19 Codex「必须改」三条，执行方不同意交整合方；2026-09-20 整合方裁决：行数按澄清后规矩（只算源码），两条测试问题成立退回补强。本版补强后重新锁定。

## 已实现

`getPersonalOverview()` 增加 `recentFindings`：已启用研究主题、最近 7 天、最新在前、最多 10 条；`isNew` 看 `app_settings` 键 `overview.findings_seen_at`（从没看过则全是新）。IPC `markFindingsSeen()` 把该键写成现在。概览页有发现才显示「最近的新发现」；点标题用系统浏览器打开（与研究页一样 `<a target=_blank>`）；「都看过了」调 IPC 再刷新。原来的「值得跟进」不动。

源码 103 行（2026-09-20 澄清：只算 `apps/*/src`、`packages/*/src`；测试、真机脚本、交付说明另计）：

```
 apps/desktop/src/main/appRuntime.ts              |  6 +
 apps/desktop/src/main/ipc.ts                     |  1 +
 apps/desktop/src/preload/index.ts                |  1 +
 apps/desktop/src/renderer/src/pages/Overview.tsx | 35 +++
 packages/contracts/src/ipc.ts                    | 10 +++
 packages/core/src/index.ts                       |  6 +-
 packages/core/src/personal/overview.ts           | 41 ++++
 packages/core/src/settings.ts                    |  3 +
```

实现未改研究定时/搜索/打分，无迁移。

## 验收测试（整合方裁决后补强、重新锁定）

- `apps/desktop/test/acceptance/w1b-recent-findings.test.ts`
  - 条件 1：2 个启用 + 1 个未启用；今天 / 3 天前 / 10 天前；只返回启用且 7 天内的，倒序；再填 11 条验证最多 10。**补强**：返回的 10 条按 id 比对就是最新的 10 条（今天 + 填充 0–8；填充 9、10 与 72 小时前那条被挤掉），不是数量对、内部倒序就行。
  - 条件 2：从没看过全 `isNew`；`markOverviewFindingsSeen` 后旧的不是新；再插入一条又是新。
- `apps/desktop/test/acceptance/w1b-overview-findings-page.test.ts`
  - 条件 3：有发现显示块、新的有 `recent-finding-new-<id>`；点「都看过了」调 `markFindingsSeen` 并刷新。**补强**：断言界面上「新」标记真的消失、发现本身还在（不是 IPC 被调过就算）。没有发现时整块不出现；「值得跟进」仍在。

`node scripts/acceptance.mjs lock W1b 概览页新发现 …` 已重新锁定（指纹 `04259a83…` / `d60de22d…`）。

## 自动化通过

- `node scripts/acceptance.mjs run W1b`：3 passed（补强后）
- `node scripts/verify.mjs`：EXIT=0（含 acceptance-lock 新指纹）
- GitHub 上的 verify：推送后看，结论补记。

## 真机通过

临时 `IXAEON_DATA_DIR` 启动已构建的 Electron（合成主题「W1b 真机合成方向」、发现「W1b 真机合成发现」），2026-09-20 重跑：

```
最近的新发现
W1b 真机合成发现 · W1b 真机合成方向 · 2026-09-20 00:36 新
都看过了
AFTER_NEW_BADGES 0
最近的新发现
W1b 真机合成发现 · W1b 真机合成方向 · 2026-09-20 00:36
都看过了
shots true true
```

「新」标消失、块仍在。截图在本机 `apps/desktop/release/screenshots/w1b-findings-before.png` 与 `-after.png`，未提交。

## Codex 审查（A 档）

2026-09-19 结论「需要修改」三条：行数一条按澄清后规矩不成立；两条测试问题整合方认同、本版已补强（见上）。补强重锁后重跑，结论补记在 `W1b-Codex审查.md`。

## 已知缺口

- 暂停但仍启用的主题，规格只说「已启用」，查询按 `enabled = 1`，不看 `paused`。
- 链接打开方式与研究页相同（`<a target=_blank>`），没有另调 `shell.openExternal`。

## 用户接受

未发生。
