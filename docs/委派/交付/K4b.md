# K4b 额度与项目活动（驾驶舱页面）交付

- 分支：`dev/K4b`，基于 `dev/K4`（K4 核心实现）；档位 **B**（界面部分，随 K4 复审）
- 执行方：dev（接力第 65 棒）
- 队列第 141 行（K4 的第二支，队列仍是一行）

## 已实现

K4 的页面部分：驾驶舱的额度卡与项目卡片上的最近活动。源码 189 行（`Cockpit.tsx` +56/−5、
新增 `CockpitQuotas.tsx` +128）；规格要求的两块页面内容都在，真机截图脚本另算。

- `apps/desktop/src/renderer/src/pages/CockpitQuotas.tsx`（新增）：每个账号一张卡——状态、各窗口
  用量条、按 `resetAt` 现算的倒计时、订阅到期日；QuotaHub 的 `collectedAt` 超过 15 分钟标黄
  「数据旧了」；手动条目写「手动 · 登记于 N 天前」，重置时间已过提示「可能已重置，请更新」；
  同一账号登记多个窗口时合成一张卡（手动额度在核心层是一项一个窗口）。
- `apps/desktop/src/renderer/src/pages/Cockpit.tsx`：顶部计数把「额度：等 K4」换成合并后的账号数；
  `sources.quotas` 为 `error` 时进「有来源不正常」；项目卡片加一行「最后提交 N 天前 · 7 天 M 次」，
  `activity.readable = false` 写「未授权读取」。K3 的模拟快照没有 `quotas` / `activity` 时按可选处理。
- `scripts/real/k4-cockpit-quota.mjs`（新增，真机检查脚本）：临时数据目录 + 合成 QuotaHub HTTP
  服务 + 两条合成手动登记，启动应用截驾驶舱额度区，输出只有卡片数、窗口数与布尔值。

**为什么拆成 K4b / K4c**：规格写「源码超 300 行就把页面部分拆成 K4b」。K4 核心已经 284 行
（`git diff --stat origin/main...dev/K4 -- apps packages`），驾驶舱页 191 行、设置页 206 行，
合在一起会过 300。按硬规矩拆成两支：本支只做驾驶舱，设置页在 `dev/K4c`（基于本支）。

## 验收测试（v2 规格任务）

- `apps/desktop/test/acceptance/k4b-cockpit-quota.test.ts`（4 条，实现阶段补的界面测试；
  **B 档新测试，等整合方锁定**）：数据旧了/用量条/倒计时；手动登记时间与「可能已重置」；
  同账号多窗口合并；项目活动的「7 天 M 次」与「未授权读取」；没配额时的空状态。
- K4 已锁定的 19 条核心测试由 `dev/K4` 带过来，本支没有改测试。

## 自动化通过

- `corepack pnpm exec vitest run --project acceptance apps/desktop/test/acceptance/k4b-cockpit-quota.test.ts`：
  4 passed。
- `node scripts/acceptance.mjs run K3`：16 passed；`run K3b`：5 passed（页面回归）。
- `corepack pnpm exec tsc --noEmit -p tsconfig.json`：退出码 0。
- 完整 `node scripts/verify.mjs` 在 `dev/K4c` 上跑（包含本支全部代码），结果见 [K4c 交付说明](K4c.md)。
- GitHub 上的 verify：等调度器推分支后看。

## 真机通过

`scripts/real/k4-cockpit-quota.mjs`（临时数据目录、合成 QuotaHub、合成手动额度；不用真实账号）
在 K4b 工作目录跑过，先 `node scripts/build.mjs`、再带 `IXAEON_ELECTRON_NO_SANDBOX=1` 运行：

```text
QUOTA_CARDS 3
QUOTA_WINDOWS 5
SHOT true
RESULT 通过：额度区三张合成卡与手动合并、数据旧了、可能已重置、截图都在
```

截图：`apps/desktop/release/screenshots/k4-cockpit-quotas.png`（工作目录内，发布产物目录不进仓库）。
图上能看到：合成 Codex 账号（正常、已用 42.5%、还有 3 小时重置、数据旧了）、合成火山账号
（需要重新登录）、Claude 合成账号（手动 · 登记于 2 天前、可能已重置，两个窗口合成一张卡）。
**这不是真实 QuotaHub 的账号数据**；真实 QuotaHub 的检查见 K4 交付说明。

## Codex 审查（A 档）

不适用：B 档，由整合方复审。

## 已知缺口

1. 本支的界面测试（4 条）是新写的 B 档测试，还没锁；整合方复审时可以改严后再 `lock K4b`。
2. 截图用的是脚本里的合成 QuotaHub，不是用户本机真实的 QuotaHub；真实那一步见 K4。
3. 额度卡的样式用的是现有 `work-run` / `update-progress-*` 类加少量内联样式，没有新增 CSS 文件。

## 用户接受

未发生（用户用过并认可之后才写）。