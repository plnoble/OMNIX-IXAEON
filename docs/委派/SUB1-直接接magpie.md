# 规格 SUB1：直接接 magpie（模型一张表、额度从 magpie 读）

档位：**B**（新的本机访问：magpie 的额度接口；聊天走的网关变了）。大小：中，拆两支——**SUB1**（模型接入加 magpie 预设、聊天跟着走 magpie）、**SUB1b**（驾驶舱额度改读 magpie、拿掉 QuotaHub），各自源码 ≤300 行。依赖：无。来源：用户 11-01（[三周任务单](../三周任务单.md)「订阅中心」一节）：「额度为啥要用 QuotaHub……你吸纳进来就好了」「我让你参考 magpie，本地的多订阅，随便切换」「你不行你就直接接 magpie，然后列出所有的模型」。参考：https://github.com/yetone/magpie （`docs/reference.md`），用户本地 `D:\Agent\Project\OMNIX-Workbench` 的同类功能。

v2 规格：先把验收条件写成测试（`*/test/acceptance/sub1-*.test.ts`）。**本周例外（用户 10-31 定）**：测试和实现一起在 `dev/SUB1`、`dev/SUB1b`（第二支基于第一支）上做完，状态改「待复审（整合方）」，不合并。

## magpie 是什么（11-01 本机实测）

- 本机网关 `http://127.0.0.1:3425`，同时说 OpenAI（`/v1`）、Anthropic、Gemini；Key 固定 `magpie`（`Authorization: Bearer magpie`）。
- `GET /v1/models`：全部订阅的模型，id 写成 `provider/model`（本机 15 个：auto、baidu-qianfan、opencode-go、kiro、workbuddy、qoder、antigravity）。
- `GET /v1/magpie/quotas/cards`：`{ object, data: Card[] }`，`Card = { provider, name, icon, plan: string, user, kind: 'subscription' | 'plan', readAt, windows: Array<{ name, used, limit, unit, resetsAt, display }>, daily: { since, days, window } }`（本机 6 张）。`POST /v1/magpie/quotas/refresh` 让 magpie 再读一次（每张卡 30 秒最多一次，参数照 magpie 文档）。

## SUB1：模型接入加 magpie 预设，聊天跟着走

1. 设置 →「模型接入」加一个按钮「用本机 magpie」：把 API 地址填成 `http://127.0.0.1:3425/v1`、API Key 填 `magpie`，接着自动点一次「检测模型」，模型清单里列出 magpie 的全部模型；用户照旧勾选、「保存选择」，再选「模型名称」（后台分析）和「聊天模型」。
2. 连不上（magpie 没开）→ 按钮下面写「没连上本机 magpie（127.0.0.1:3425），先把 magpie 打开」，表单不动。
3. **聊天也要真的走 magpie**：现在聊天（Hermes）只从 IXAEON 拿模型名（`HERMES_MODEL`），连哪个网关看的是 Hermes 自己的 `config.yaml`。选了 magpie 的模型、Hermes 却还连着别的网关，就会「模型没有可用渠道」。执行方先读 `runtime/hermesLocator.ts`、`runtime/adapter.ts` 弄清 Hermes 起进程时能不能用环境变量带上网关地址和 Key（照 `HERMES_MODEL` 的做法、不写回 Hermes 的配置文件）；能 → 「模型接入」的地址和 Key 一起交给 Hermes；不能 → 停下，把查到的写进交付说明，转整合方定，不要自己改 Hermes 的配置文件。

## SUB1b：驾驶舱额度改读 magpie，拿掉 QuotaHub

1. 额度来源换成 magpie：`packages/core/src/cockpit/quotas.ts` 读 `GET <magpie>/v1/magpie/quotas/cards`（`<magpie>` 默认 `http://127.0.0.1:3425`，设置项 `cockpit.magpie_url` 可改，只认本机 `http://127.0.0.1` / `localhost` + 端口，沿用 K4 的地址校验），3 秒超时。默认就开（用户要直接接）；连不上 → 额度来源记 `missing`，note「没连上 magpie」，驾驶舱照常。
2. 字段映射到 K4 的 `QuotaCard`：`source: 'magpie'`；`provider`←`provider`；`account`←`name`；`plan`←`plan`；`collectedAt`←`readAt`；每个窗口 `name`←`name`、`resetAt`←`resetsAt`、`usedPercent` = `used`（**magpie 的 `used` 本身就是百分比**——11-01 整合方对照本机实测更正：workbuddy 卡 `used: 10.13`、`limit: 6900`、`display: "699.25 / 6900"`，699.25 / 6900 = 10.13%；不要再拿 `limit` 去除）；`used` 不是数就 `null`；窗口另加 `display: string | null`←`display`（magpie 给人看的那句，原样显示）。**`user`、`icon`、`daily` 不进快照**（`user` 多半是邮箱；快照还会经 K5 发到手机）。
3. 驾驶舱额度区加「刷新」按钮 → 主进程调 `POST <magpie>/v1/magpie/quotas/refresh`（照 magpie 文档带参数），再重读卡片；30 秒内连点只发一次。
4. **拿掉 QuotaHub**：设置里的 QuotaHub 地址、`cockpit.quotahub_url` 的读取、`quotas.ts` 里请求 QuotaHub 的代码都删掉；「手动登记」照留（magpie 管不到的订阅还能手填）。K4 锁定测试里测 QuotaHub 的那几条会撞红：执行方不改，交付说明里列出（文件、用例名），整合方合并时改。

## 契约

- `QuotaCard.source` 加 `'magpie'`；窗口加 `display: string | null`（`packages/contracts/src/cockpit.ts`）。
- IPC 加 `refreshMagpieQuotas(): Promise<{ ok: true }>`；「用本机 magpie」走现有的检测和保存通道，不另开写配置的 IPC。

## 约束

- 只访问本机 magpie；不读 magpie 的配置文件、数据库、登录信息；只走它的 HTTP 接口。
- Key `magpie` 照现有方式加密保存；测试、交付说明、截图里不出现 `user` 字段的值（用合成数据）。
- 不改 magpie，不改 Hermes 的配置文件。

## 验收条件

**SUB1**
1. 合成 magpie（测试里起的本地 HTTP 服务，`/v1/models` 回 3 个 `prov/model`）→ 点「用本机 magpie」后 API 地址、Key 填好，模型清单里正好这 3 个。
2. 合成服务没起 → 出「没连上本机 magpie」那句，地址和 Key 不变。
3. 聊天：保存 magpie 预设、聊天模型选 `prov/m1` → 起 Hermes（替身）时它收到的网关地址是合成 magpie 的、Key 是 `magpie`、模型是 `prov/m1`（或执行方查明做不到，交付说明写清、转整合方）。

**SUB1b**
4. 合成 magpie 的 `quotas/cards` 回 2 张卡（窗口里 `used` 分别是 `10.13`（带 `limit: 6900`）、`0`、缺）→ 快照 `quotas` 来源 `ok`、2 张卡，`usedPercent` 分别是 10.13、0、null（**不拿 limit 去除**），`display` 原样；快照 JSON 里找不到合成卡片的 `user` 值（`someone@example.invalid`）。
5. 合成服务没起 → 来源 `missing`、note 含「没连上 magpie」，快照其余照常。
6. `cockpit.magpie_url` 设成 `http://example.com:3425` → 拒绝、不发请求。
7. 点刷新 → 合成服务收到一次 `POST /v1/magpie/quotas/refresh`；30 秒内再点 → 不再发。
8. 设置页里不再有 QuotaHub 地址；快照里没有 `source: 'quotahub'` 的卡；手动登记照旧出现。

## 真机检查

- 甲（开发做）：设 `IXAEON_DATA_DIR=<临时目录>` 起应用，点「用本机 magpie」（**用户本机真的 magpie**，只读它的模型和额度），截图模型清单（只露模型名）和驾驶舱额度区（截图前把卡片上的账号名遮掉）；再选一个 magpie 模型当聊天模型问一句「只回复两个字母：OK」，贴出回答。
- 乙（用户做）：用户自己在应用里点一次「用本机 magpie」、选模型、在驾驶舱看额度。交付说明写「待用户实测」。
