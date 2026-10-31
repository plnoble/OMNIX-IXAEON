# K4c 额度与项目活动（设置页）交付

- 分支：`dev/K4c`，基于 `dev/K4b`（K4 核心 + 驾驶舱页）；档位 **B**（界面部分，随 K4 复审）
- 执行方：dev（接力第 65 棒）
- 队列第 141 行（K4 的第三支，队列仍是一行）

## 已实现

K4 的设置页部分。源码 206 行，界面测试另算。

- `apps/desktop/src/renderer/src/pages/QuotaSettings.tsx`（新增 +151）：「额度来源」卡片。
  QuotaHub 地址（留空 = 关闭，只显示手动额度）、保存；手动额度列表（账号 · 窗口 · 重置时间、
  可删）；登记表单：账号显示名、窗口（5 小时 / 每周 / 其他 + 自定义名）、下次重置（datetime-local）、
  订阅到期（date）、备注（可选）。登记时写 `registeredAt = 现在`，每条一个窗口。
- `packages/contracts/src/ipc.ts`（+24/−4）：`SettingsView.cockpit` 增加 `quotahubUrl`、
  `manualQuotas`（都带默认值，K3 的调用方不用改）；`saveCockpitSettings` 的入参改成可选键
  `{ ixaeonRepo?, quotahubUrl?, manualQuotas? }`，只写传进来的键。这是对 K3 已认接口的**加字段/放宽**，
  没改名、没删字段；K3 锁定的设置页测试（只传 `ixaeonRepo`）照旧过。
- `apps/desktop/src/main/ipc.ts`（+28/−2）：`getSettings` 读回 `cockpit.quotahub_url` 与
  `cockpit.manual_quotas`（坏 JSON 当没有，和核心层一致）；`saveCockpitSettings` 按传入的键写
  `app_settings`，手动额度序列化成核心层用同一份 `manualQuotaSchema` 校验的 JSON 数组。
- `apps/desktop/src/renderer/src/pages/Settings.tsx`（+3）：在「驾驶舱」卡片后挂上
  `<QuotaSettingsCard />`。没有动 K3 的仓库路径输入框与保存按钮。

## 验收测试（v2 规格任务）

- `apps/desktop/test/acceptance/k4c-quota-settings.test.ts`（5 条，实现阶段补的界面测试；
  **B 档新测试，等整合方锁定**）：读回地址与手动条目；保存地址只传 `quotahubUrl`；
  登记一条（账号、窗口、重置、到期、备注、登记时刻）；窗口「其他」用自定义名；
  删掉一条后保存剩下的。
- K4 已锁定的 19 条核心测试、K3/K3b 已锁定的 21 条页面/设置测试由前面的分支带过来，本支没有改。

## 自动化通过

- `corepack pnpm exec vitest run --project acceptance apps/desktop/test/acceptance/k4c-quota-settings.test.ts`：
  5 passed。
- `node scripts/acceptance.mjs run K3`：16 passed；`run K3b`：5 passed（K3 设置页与页面回归）。
- `corepack pnpm exec tsc --noEmit -p tsconfig.json`：退出码 0。
- `node scripts/acceptance.mjs run K4`：19 passed；`run K2`：21 passed；`run P3`：6 passed；`run G02`：5 passed。
- `node scripts/verify.mjs`：见下方原样输出。
- GitHub 上的 verify：等调度器推分支后看。

## 真机通过

规格要求的真机检查是「本机 QuotaHub 在运行时跑 K2 的 `cockpit-snapshot.ts`（只输出数字）」和
「截图驾驶舱的额度区（合成数据）」。前者在 K4 上跑过，截图在 K4b 上跑过；设置页本身规格没有另列
真机检查，本支用界面测试与 K3 的设置页回归覆盖，没有单独截图。

## Codex 审查（A 档）

不适用：B 档，由整合方复审。

## 已知缺口

1. 本支的界面测试（5 条）是新写的 B 档测试，还没锁；整合方复审时可以改严后再 `lock K4c`。
2. `saveCockpitSettings` 的入参从必填 `ixaeonRepo` 放宽成可选键，是对 K3 已认接口的加法；如果整合方
   要改回每个设置一个通道，设置页和测试跟着改。
3. 手动额度表单没有做编辑（只能删了重登）；规格只要求登记与展示，够用但不好改一条旧记录。

## 用户接受

未发生（用户用过并认可之后才写）。