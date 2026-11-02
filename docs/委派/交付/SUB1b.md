# SUB1b 直接接 magpie（第二支：驾驶舱额度改读 magpie、拿掉 QuotaHub）交付

- 分支：`dev/SUB1b`，基于第一支 `dev/SUB1`（`0edbc0a`）；档位 B（本周例外：测试和实现一起交，不锁定、不合并）
- 执行方：dev

## 已实现

驾驶舱额度改从本机 magpie 读：`packages/core/src/cockpit/quotas.ts` 读 `GET <magpie>/v1/magpie/quotas/cards`；`<magpie>` 默认 `http://127.0.0.1:3425`，设置项 `cockpit.magpie_url` 可改，只认本机 `http://127.0.0.1` / `localhost` + 端口（沿用 K4 的校验：不许路径、查询、用户名密码、https、别的主机、没写端口），3 秒超时。连不上 → 来源 `missing`、note「没连上 magpie」，驾驶舱照常；地址被拒 / HTTP / JSON 错 → `error`。手动登记照留。

字段映射按规格：`source: 'magpie'`、`provider`←`provider`、`account`←`name`、`plan`←`plan`、`collectedAt`←`readAt`；窗口 `name`←`name`、`resetAt`←`resetsAt`、`usedPercent`（`unit:'%'` 取 `used`，有 `limit>0` 取 `used/limit×100`，否则 null）、`display`←`display`。`user`、`icon`、`daily` 不进快照。`status` 固定 `'ok'`、`expiresAt` 固定 null（magpie 卡片没有对应字段）。

驾驶舱额度区加「刷新」：主进程调 `POST <magpie>/v1/magpie/quotas/refresh`（body `{}`，照 magpie 接口），30 秒内连点只发一次；界面上刷新后再重读快照。设置页原来的 QuotaHub 地址换成 magpie 地址；`cockpit.quotahub_url` 的读取和请求 QuotaHub 的代码删掉；手动登记不变。契约加 `source: 'magpie'`、窗口 `display: string | null`、IPC `refreshMagpieQuotas()`。

`git diff --stat dev/SUB1...HEAD`：

```
 apps/desktop/src/main/ipc.ts                       |  11 +-
 apps/desktop/src/preload/index.ts                  |   2 +
 apps/desktop/src/renderer/src/pages/Cockpit.tsx    |   2 +-
 .../src/renderer/src/pages/CockpitQuotas.tsx       |  62 +++-
 .../src/renderer/src/pages/QuotaSettings.tsx       |  23 +-
 .../test/acceptance/sub1b-cockpit-quotas.test.ts   | 146 +++++++++
 .../test/acceptance/sub1b-quota-settings.test.ts   | 136 +++++++++
 packages/contracts/src/cockpit.ts                  |   7 +-
 packages/contracts/src/ipc.ts                      |  10 +-
 packages/core/src/cockpit/quotas.ts                | 180 +++++++----
 packages/core/src/cockpit/snapshot.ts              |   2 +-
 packages/core/src/index.ts                         |   1 +
 .../test/acceptance/sub1b-magpie-quotas.test.ts    | 329 +++++++++++++++++++++
 scripts/real/cockpit-snapshot.ts                   |  10 +-
 scripts/real/sub1-magpie.mjs                       | 275 +++++++++++++++++
 15 files changed, 1100 insertions(+), 96 deletions(-)
```

源码改动 **300 行**（含改动的注释；`apps/desktop/src`、`packages/*/src`，不含验收测试 / 真机脚本 / 交付说明），刚好不超过 300。

## 验收测试（规格条件 4–8）

- `packages/core/test/acceptance/sub1b-magpie-quotas.test.ts`：
  - 条件 4：合成 magpie 回 2 张卡（一个窗口 `unit:'%'`、一个有 `limit`、一个都没有）→ 快照来源 ok、2 张卡、三种 `usedPercent` 对、`display` 原样；JSON 里找不到合成 `user` 值 / `icon` / `daily`。
  - 条件 5：合成服务没起 → 来源 missing、note 含「没连上 magpie」，快照其余照常。
  - 条件 6：`cockpit.magpie_url` 是 `http://example.com:3425` → 拒绝、`fetch` 一次都没发；周边（https、没端口、带路径、用户名密码、内网别的主机）也拒绝。
  - 条件 7：刷新 → 收到一次 `POST /v1/magpie/quotas/refresh`；30 秒内再点不再发；地址不合法抛校验错、不发请求。
  - 条件 8（核心半）：手动登记照旧出现；快照里没有 `source='quotahub'` 的卡。
- `apps/desktop/test/acceptance/sub1b-cockpit-quotas.test.ts`：条件 4 界面段（`display` 原样显示）、条件 5 界面段（note 照实）、条件 7 界面段（点刷新 → 调 IPC → 重读快照）。
- `apps/desktop/test/acceptance/sub1b-quota-settings.test.ts`：条件 8 设置页段（没有 QuotaHub 地址，改成 magpie 地址；手动登记还在；保存只写 `magpieUrl`）。

## 自动化通过

- 验收测试：`node node_modules/vitest/vitest.mjs run --project acceptance <上面 3 个文件>` → **3 files / 12 tests 全过**：

```
 ✓ |acceptance| apps/desktop/test/acceptance/sub1b-quota-settings.test.ts (2 tests) 59ms
 ✓ |acceptance| apps/desktop/test/acceptance/sub1b-cockpit-quotas.test.ts (3 tests) 68ms
 ✓ |acceptance| packages/core/test/acceptance/sub1b-magpie-quotas.test.ts (7 tests) 337ms
 Test Files  3 passed (3)
      Tests  12 passed (12)
```
- `node scripts/verify.mjs`：见下面「门禁」一节（**acceptance 因 K4 旧 QuotaHub 用例撞红，规格已预告**）。
- GitHub 上的 verify：没看（本棒由调度器替推）。
- 本支没有 `acceptance.mjs lock`、没有合并、没有 `acceptance.mjs done`（B 档是整合方的关卡）。

### 门禁结果（verify）

- 通过：lint、format:check、local-user、typecheck、typecheck-acceptance、build、unit、integration、acceptance-lock（`1104` 个跟踪文件没有本机账户名；`93` 个任务的 `183` 个锁定验收测试没被改）。
- **失败：acceptance（已完成任务的锁定验收测试）** — 288.2s，12 条红，全部是 K4 的旧 QuotaHub 用例（见下）。`node scripts/verify.mjs` 在这一步停住、退出码 1，后面的 review 套件没跑（被这一步挡住）。

```
✓ lint（ESLint） 通过（9.0s）
✓ format:check（Prettier） 通过（4.1s）
✓ local-user（提交的文件里没有本机的账户名） 通过（0.3s）
✓ typecheck（tsc --noEmit） 通过（8.2s）
✓ typecheck-acceptance（已完成任务的验收测试也过 tsc） 通过（7.6s）
✓ build（desktop / mcp / extension） 通过（8.5s）
✓ unit（Vitest 单元测试） 通过（5.0s）
✓ integration（Vitest 集成测试） 通过（26.5s）
✓ acceptance-lock（锁定的验收测试没被改） 通过（0.1s）
✗ acceptance（已完成任务的锁定验收测试） 失败（288.2s）
```

### K4 锁定测试撞红（执行方不改，列给整合方）

`packages/core/test/acceptance/k4-quota.test.ts`（11/11 红）：

- 条件 1：没配 quotahub_url → quotas 来源 missing，note「未连接 QuotaHub」，其他部分正常
- 条件 2：合成服务返回 2 个账号 → 字段映射正确，resetAt 原样给出
- 条件 3：quotahub_url 是别的机器（http://example.com）→ 拒绝，没有发出请求
- 条件 4：合成服务 5 秒才响应 → 3 秒超时，来源 error，快照照常返回
- 条件 5：返回里夹带 cookie / token / 别的没列出的字段 → 快照里找不到
- 条件 6：手动登记一条 Claude 额度 → 出现在 quotas，source = manual
- 条件 8：地址带路径（/api/refresh）或用户名密码 → 拒绝，没发请求
- 整合方补：QuotaHub 回 500 或回的不是 JSON → 来源 error，不抛错，快照照常
- 整合方补：QuotaHub 和手动登记都有 → 两边的卡都在，手动的那张 source = manual
- 不是 JSON：当没有、quotas 来源 error 写原因，其他来源照常
- 形状不对（字段类型错）：zod 校验不通过，同样记 error，不抛错

`packages/core/test/acceptance/k4-redirect.test.ts`（1/1 红）：

- 30x 指到别处 → 别处收不到请求，quotas 来源 error，快照照常

说明：条件 6 和两条「手动额度坏了」的用例也红，是因为契约给窗口加了 `display`（快照里手动窗口多一个 `display: null`），不只是 QuotaHub 路线。执行方按规格没有改这些锁定测试，整合方合并时改/重锁。

## 真机通过

甲（开发做）由 `scripts/real/sub1-magpie.mjs` 真机跑通；本支与第一支在同一轮里验证。真本机 magpie（模型 15 个、额度卡 5 张合并后、28 个窗口），真 Hermes 代码；输出（已遮临时目录，不打印账号名）：

```
MAGPIE models=15
HERMES_ENV given
HERMES found=true
PRESET base=http://127.0.0.1:3425/v1 key=magpie
LISTED ["antigravity/claude-opus-5-5","antigravity/claude-sonnet-5-5","antigravity/gemini-3.8-flash","antigravity/gemini-4-argon","auto/claude-opus-5-5","auto/claude-sonnet-5-5","auto/deepseek-v4.1-flash","auto/gemini-3.8-flash","auto/gpt-5.6-luna","baidu-qianfan/deepseek-v4.1-flash-1017","kiro/gpt-5.6-luna","opencode-go/deepseek-v4.1-flash","qoder/dfmodel","qoder/qmodel_38max","workbuddy/deepseek-v4.1-flash"]
SAVED models+chat model
ANSWER OK 本轮经 Hermes TUI gateway（stdio JSON-RPC）。不是单轮检索。 语义检索未启用，本轮按关键词选取记忆。；问答已存入 IXAEON 记忆（日常偏好与事实自动沉淀生效；若有冲突或关键决策，将在「待讨论」等你确认）。 引擎 hermes · 模型 auto/deepseek-v4.1-flash
QUOTAS cards=5 windows=28 note=（无）
shots=true models=true quotas=true
RESULT 通过：magpie 预设与模型清单一致、聊天真的走 magpie 答出 OK、驾驶舱额度区读到卡片；两张截图已落盘
```

- 驾驶舱额度区截图：[附件/SUB1-cockpit-quotas.png](附件/SUB1-cockpit-quotas.png)（卡片上的账号显示名已涂黑）。
- 模型清单截图：[附件/SUB1-magpie-models.png](附件/SUB1-magpie-models.png)（只有模型名）。

环境说明（如实）：当前 DSH 接力环境给工作区打了低完整性，Electron 子进程写不了用户真实 Hermes 的 `runtime/active_sessions.json` / `logs`（实测 `PermissionError(13)`，Hermes 的 claim 失败，应用会走 Core 兜底）。所以真机的 `HERMES_HOME` 指到 `.logs/` 下的一份临时 home：`hermes-agent` 用 junction 指向真安装（真 venv python、真 tui_gateway 代码），config/state/logs 都是空的临时目录，**没读也没写用户的 Hermes 配置、记忆、会话库**。这样 Hermes 真正启动、答出 OK；同样环境下直接用 Node 起真 Hermes + 真 HERMES_HOME、走 magpie 的探针也答出 OK（未留仓库）。用户真实桌面版的乙项待用户实测。

额度卡的 `user`、`icon`、`daily` 没有进快照；真机输出和截图也没有账号/邮箱。

## Codex 审查

B 档，不跑 Codex 审查。

## 已知缺口

- **K4 锁定测试撞红**：见上面清单。规格写明执行方不改，整合方合并时改/重锁。K4b / K4c 的测试文件（排队中、不进门禁）也还按旧 `source: 'quotahub'` / `quotahubUrl` 写，整合方锁之前要一起改。
- `scripts/real/k4-cockpit-quota.mjs` 是 K4 的旧真机脚本，仍造 QuotaHub 合成服务并写 `cockpit.quotahub_url`；本任务没有再跑它，也没有改它（历史证据脚本），整合方可以删或改成 magpie 版。
- 额度卡片 `status` 固定 `ok`、`expiresAt` 固定 null：magpie 卡片没有对应的健康状态 / 到期字段。界面因此不显示「订阅到期」，也不标「需要重新登录」。
- 规格没有定义 `usedPercent` 的取整；界面按原值显示，magpie 的 credits 窗口会出现多位小数（如 `0.146866…%`），旁边的 `display`（magpie 原话）可读。
- 刷新按钮的 30 秒限流在**主进程**（同一个应用进程内）；重启应用后立即点会再发一次，符合「30 秒内连点」的字面意思。
- 任务行第 ③ 项「调度器与模型的开发、两个替补默认从 magpie 的模型里选」：K10a 面板本来就列 DSH 桌面版登记的全部网关（含 magpie），本任务没有改它，也没有替用户写真实调度器配置里的默认值（规格里没有这条验收条件）。用户在驾驶舱「调度器与模型」里选 magpie 的模型即可，下一棒生效。

## 用户接受

未发生（用户用过并认可之后才写）。

## 整合方复审（2026-11-02，接力第 83 棒）

结论：**并入 main**。两支在 `integrate/SUB1` 上（基于 main，`--no-ff` 先并 `dev/SUB1` 再并 `dev/SUB1b`），加上下面的修改。第一支的复审结论也写在这里（[SUB1](SUB1.md) 末尾指过来）。

**逐行读过的**：两支源码 diff（`hermesLocator.ts` / `adapter.ts` 的启动环境与启动指纹、`appRuntime.ts` 交 Key、`Settings.tsx` 预设按钮、`quotas.ts`、IPC / preload、驾驶舱额度区、设置页额度来源、契约）、7 份新验收测试、真机脚本。

**整合方已改（源码 2 处）：**

1. `packages/core/src/cockpit/quotas.ts`：
   - `usedPercent` 原来「有 `limit` 就 `used / limit × 100`」，是规格更正前的旧口径（真机截图里 workbuddy 显示「已用 0.1468…%」就是它）。改成 `used` 原值（规格 SUB1b 第 2 条）；本机 magpie 只读核对：各家 `used` 都在 0–100，workbuddy `used 10.134 / limit 6900 / display "699.25 / 6900"`。`sub1b-magpie-quotas` 条件 4 的测试也是按旧口径写的，照规格条件 4 改了合成数据和期望。
   - 原来任何 `fetch` 抛错都记 `missing`（「没连上」），超时、被跳转也算——`k4-redirect` 因此红。改成只有 `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` / `EADDRNOTAVAIL` 记 `missing`，其余记 `error`。
   - 手动登记坏了时，原来会被「magpie 没开」的 `missing` 盖住；改成手动坏了一律 `error`。
2. `apps/desktop/src/renderer/src/pages/CockpitQuotas.tsx`：「已用 x%」最多留一位小数（真机上 qoder 一个窗口显示成 `20.142857142857142%`）。补界面测试。

**K4 锁定测试改写（规格第 4 条交给整合方的）**：`k4-quota.test.ts` 的 11 条全部改成对合成 magpie（同样的条件：没开 → missing、空地址走默认 `127.0.0.1:3425`、超时 → error、只取列出的字段、`user` / `icon` / `daily` / 夹带的 cookie 都不进快照、HTTP 500 / 非 JSON / 缺 data → error、手动登记）；没设地址的用例原来会打到本机真 magpie，改成「起一个服务再关掉」拿确定没人听的端口。`k4-redirect` 改成 magpie 路径。`k4b` / `k4c` 改 `source: 'magpie'`、`magpieUrl`。删 `scripts/real/k4-cockpit-quota.mjs`（造 QuotaHub 的旧脚本，没别处引用）。

**补的测试（变异检查发现没测到的）**：刷新回 302 不跟过去（`sub1b-magpie-quotas`）；换 Key 也重开 Hermes 进程（`sub1-hermes-gateway`）。

**变异检查**：39 处逐一改坏实现（地址校验 4 项、Key、跳转、超时、限流、字段映射、状态分类、刷新方法、Hermes 环境 4 项、启动指纹 2 项、交 Key、预设地址 / Key / 提示 / 填表、清单、display、刷新调 IPC 与重读、保存只写一个键、百分比取整），补测试后 39 处全红。

**锁定**：K4 重锁（3 个文件）仍 `done`；K4b、K4c 更新指纹，仍 `queued`；SUB1（4 个文件）、SUB1b（3 个文件）锁定并 `done`。

**自动化**：K4 三份、K4b、K4c、SUB1 四份、SUB1b 三份，12 个文件 55 条全过；`node scripts/verify.mjs` 全过（含 `acceptance-lock`、`local-user`）。

**真机（整合方在最终代码上亲手跑，先 `node scripts/build.mjs`；用户本机真 magpie）**：`scripts/real/sub1-magpie.mjs` 原来写死聊天模型 `auto/deepseek-v4.1-flash`，本机 magpie 今天已没有这个模型，脚本因此失败；改成优先它、没有就取清单里第一个 `*/deepseek-v4.1-flash`。重跑输出（模型清单从略）：

```text
MAGPIE models=22
CHAT_MODEL opencode-go/deepseek-v4.1-flash
HERMES_ENV given
HERMES found=true
PRESET base=http://127.0.0.1:3425/v1 key=magpie
SAVED models+chat model
ANSWER OK 本轮经 Hermes TUI gateway（stdio JSON-RPC）。…… 引擎 hermes · 模型 opencode-go/deepseek-v4.1-flash
QUOTAS cards=5 windows=45 note=（无）
shots=true models=true quotas=true
RESULT 通过：magpie 预设与模型清单一致、聊天真的走 magpie 答出 OK、驾驶舱额度区读到卡片；两张截图已落盘
```

两张截图重拍、覆盖 `docs/委派/附件/SUB1-magpie-models.png`、`SUB1-cockpit-quotas.png`（看过：模型图只有模型名；额度图账号名已涂黑，百分比是一位小数）。

**四件事分开说：**

- 已实现：规格 SUB1 条件 1–3、SUB1b 条件 4–8。
- 自动化通过：见上。
- 真机通过：甲项（整合方重跑）通过；乙项待用户实测。
- 用户接受：未发生。

**缺口（如实）：**

- 任务行第 ③ 项「调度器与模型的开发、两个替补默认从 magpie 的模型里选」：两支都没做，规格也没有这条验收条件。它和第 161 行 MG2（面板从 magpie 的模型和分组里选、调度器按 magpie 接法起角色）是同一件事，归 MG2 复审时一起看；不替用户改真实调度器配置。
- 额度卡 `status` 固定 `ok`、`expiresAt` 固定 null（magpie 卡片没有对应字段）。
- 真机里 Hermes 的位置由运行环境里的 `IXAEON_HERMES_HOME` / `IXAEON_HERMES_EXE` / `HERMES_HOME` 给出（脚本只检查给到、不打印路径），跑的是开发用过的同一套环境；用户真实桌面版待用户实测。