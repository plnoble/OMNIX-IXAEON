# MP2 交付说明（本轮：只交测试）

规格：`docs/委派/MP2-多个模型供应商.md`（MP2 条件 1–10、MP2b 条件 11–15）。
B 档流程：本轮**只写测试、登记指纹**，不写实现。分支 `dev/MP2`。

## 一、已实现

**没有实现**。这一轮只写验收测试；源码、配置 schema、IPC、界面一行都没动（`git status` 里只有测试与本文档）。

## 二、测试清单（条件逐条对应）

| 文件                                                    | 条数 | 覆盖条件                                                                                                                            |
| ------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/test/acceptance/mp2-providers.test.ts`    | 14   | 1（旧配置照样能读）、2（Key 只在主进程/视图给后四位）、3（改地址来源清 Key）、5（两家互不影响）、8（删除）、9（magpie）、10（审计） |
| `apps/desktop/test/acceptance/mp2-fetch-models.test.ts` | 4    | 4（`GET /models`、只取 id 去重、302 不跟随、超时不抛错、Key 用不用）                                                                |
| `apps/desktop/test/acceptance/mp2-uses.test.ts`         | 8    | 6（按用途取模型 / 聊天走直连 / 拒绝未勾选 / 选 default 写旧字段）、7（那家没了或解不开 → null，不借别家 Key）                       |
| `apps/desktop/test/acceptance/mp2b-model-page.test.ts`  | 9    | 11（导航与设置页搬家）、12（供应商卡片）、13（用途下拉框）、14（聊天/编码的模型下拉框）、15（删正在用的）                           |

合计 **35 条**。没有连真网关、没有用真 Key：地址全是 `127.0.0.1` 的合成端口（`mp2-fetch-models` 里用 `node:http` 现起随机端口的假服务），
Key 是 `sk-synthetic-…` 合成值，模型名是 `demo-a` / `demo-b`。导出的契约（`ModelProviderView`、`AppRuntime.listModelProviders` 等）
照规格「契约」一节原样使用；`chatLaunchOptions()` 是私有方法，测试用类型转换按契约形状直接调，没有额外发明公开方法。

## 三、现在为什么是红的（红得对不对）

`node node_modules/vitest/vitest.mjs run --project acceptance <四个文件>` → **35 条全红**，报错是：

```
TypeError: runtime.saveModelProvider is not a function
TypeError: runtime.listModelProviders is not a function
```

也就是「功能还没有」，不是测试写错。有两条「应当拒绝」的用例一开始被 `TypeError` 凑巧满足成假绿
（`expect(() => …).toThrow()` 对「方法不存在」也成立），已收紧成断言**给用户看的中文拒绝理由**
（`/默认|default/i`、`/magpie/i`、`/本机|magpie|地址/i`），现在 14/14 全红，没有假绿。

## 四、冲突的锁定测试（**没有改它们**，由整合方定口径）

我逐个核对了规格列的那 9 个文件，按「它们实际读的 testId / 文案」判断：

| 锁定测试                           | 命中                                      | 为什么会撞                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m2-settings-ui.test.ts`           | 21 处，`settings-model`                   | 它整份渲染设置页的「模型接入」卡片并逐条断言（首次检测、勾选、筛选、保存）。MP2b 条件 11 要求把这张卡片从设置页搬走 → 整份失效                                             |
| `m3-settings-ui.test.ts`           | 3 处，`settings-model` / 文案「模型接入」 | 同上：M3 的 Key 修改/清除规则断言挂在设置页那张卡片上                                                                                                                      |
| `sub1-magpie-preset.test.ts`       | 5 处，`settings-model` / 文案「模型接入」 | 「用本机 magpie」一键预设按钮原来在设置页模型卡片里，MP2b 条件 12 把它搬到「模型」页的添加表单旁                                                                           |
| `sub1b-quota-settings.test.ts`     | 3 处，`settings-quota` / 文案「额度来源」 | 条件 11 要求设置页没有 `settings-quota` 这张卡（额度搬进 magpie 那张供应商卡片）                                                                                           |
| `k4c-quota-settings.test.ts`       | 2 处，文案「额度来源」                    | 同上，按文案定位额度卡片                                                                                                                                                   |
| `v4-settings-page.test.ts`         | 1 处，`settings-coding`                   | 设置页卡片清单/布局断言：模型接入与额度两张卡搬走后，骨架变化                                                                                                              |
| `u2-settings-coding-saved.test.ts` | 7 处，`settings-coding`                   | 「编码任务交给谁」的模型下拉框选项文案按条件 14 变成「供应商名 · 模型」                                                                                                    |
| `d7b-pages.test.ts`                | 17 处，`settings-coding`                  | 同上：模型下拉框的选项与保存规则变了                                                                                                                                       |
| `cf0-chat-model-switch.test.ts`    | **0 处** testId 命中                      | 不读上面那些 id，所以**不因搬家而红**；但条件 14 改了聊天换模型的选项文案为「供应商名 · 模型」，若它断言了具体选项文字，会因文案变化而红——这一条要整合方看它到底断言了什么 |

需要整合方决定的是：`m2-settings-ui`、`sub1-magpie-preset`、`sub1b-quota-settings`、`k4c-quota-settings` 这四份
测的界面元素**按规格要搬走或消失**，只能改写（改到新页面）或退役；`u2`、`d7b`、`v4`、`cf0` 是选项文案/骨架变化，
按规格改期望值即可。**我没有动它们任何一行。**

## 五、两处读法说明（不改条件，交整合方核）

1. **条件 9 的「地址来源」**：我用 `http://127.0.0.1:<端口>` 作为「来源」，断言 `cockpit.magpie_url` 等于去掉 `/v1` 之后的那串
   （`http://127.0.0.1:39123`）。若实现打算保留路径，这条要跟着改。
2. **`getProvider()` 的 `baseUrl`**：条件 6 只说「`getProvider()` 还是 default」，我按现有 `ModelProvider` 的形状多断言了 `baseUrl`；
   若规格不希望暴露地址，删掉那一行即可。

## 六、真机检查

**未跑**（本轮只交测试，功能还没实现；甲/乙/丙都做不了）。按流程等测试锁定后再写实现、再跑真机。

## 七、用户接受

**未取得**，`待用户实测`（丙）。
