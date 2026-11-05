# MP3 交付说明（B 档，先只推测试）

规格：[MP3-用途替补.md](../MP3-用途替补.md)。本单只写测试，不写实现；实现等整合方在 main 锁定后再做（MP3 在 dev/MP3，MP3b 的实现以后在 dev/MP3b）。

## 写了哪些测试、对应规格哪一条

| 文件                                                    | 对应验收条件                             | 内容                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/acceptance/mp3-chain.test.ts`       | 条件 2                                   | `resolveModelUseChain`：主选在前替补在后；主选没了/没 Key 从第一个能解析的替补开始；去重；聊天没单独选过时整串等于后台分析（聊天替补不生效）；全解析不出来返回空数组                                                                                                                                                                                                         |
| `apps/desktop/test/acceptance/mp3-config.test.ts`       | 条件 1、9，规格「要什么」第 8 条（审计） | `saveModelFallbacks`：合法列表存进 `config.fallbacks` 且 `getSettings()` 原样读回；拒绝没勾选过的模型 / 不存在的供应商 / 超 4 项 / 有重复 / 跟主选相同（配置不变）；只传 chat 时 analysis 不动、空数组清空；删供应商时被替补用着要拒绝并写明用途；保存记一条审计（只有用途和项数、无模型名）                                                                                 |
| `apps/desktop/test/acceptance/mp3-chat.test.ts`         | 条件 3、4、5、6、7                       | 聊天用 CF3c 接缝 `chatStreamClient(launch)` 按 `launch.model` 换假客户端：主选 429/401/5xx/连不上各一次 → 替补回答、`meta.modelName` 是替补、`meta.notice` 原因对、替补收到的消息同主选；400/流出正文后出错 → 不换；两个都不行 → failed 且错误说明含两候选与原因；换过后本轮后面几轮工具调用都发替补、主选只调一次；假时钟 5 分钟记忆与保存即恢复、整串都在 5 分钟内全部再试 |
| `apps/desktop/test/acceptance/mp3-analysis.test.ts`     | 条件 8                                   | 本机两个 HTTP 假服务（429 / 正常）：`getProvider()` 走替补链，结果来自第二个；日志有一条换替补（两边供应商与模型、原因），不含地址/Key/提示词；两个都不行 → 抛错交给上层                                                                                                                                                                                                     |
| `packages/core/test/acceptance/mp3-model-error.test.ts` | 条件 10                                  | `ModelError.status`：构造带 status；`FakeStreamChatClient` 剧本一步的 `status` 带到抛出的错误；聊天客户端与后台分析客户端收到 HTTP 429 → `status=429`，连不上 → 无 `status`                                                                                                                                                                                                  |
| `apps/desktop/e2e/mp3b-ui.spec.ts`                      | 条件 11（界面，端到端）                  | 「模型」页「用途」里两个替补列表：加/上移/下移/删、保存后刷新顺序不变；满 4 项「添加」不可点；下拉里没有主选与已在列表里的；聊天选「跟着后台分析」时列表收起并显示说明；保存被拒提示原样显示                                                                                                                                                                                 |
| `apps/desktop/e2e/mp3b-fallback.spec.ts`                | 条件 12（端到端）                        | 假聊天剧本第一个候选回 429、第二个正常回答；配好替补后问一句，对话里出现替补的回答和那句提示                                                                                                                                                                                                                                                                                 |

条件 11 最后一小条「聊天里带替补提示的回答下面显示那句话」是聊天页渲染，由 `apps/desktop/e2e/mp3b-fallback.spec.ts`（条件 12 端到端）覆盖。

锁定：`node scripts/acceptance.mjs lock MP3 "聊天和后台分析的替补"` 已登记 6 个验收测试文件（e2e spec 不属于 acceptance 锁）。

测试里的地址只用 `127.0.0.1` 加端口，Key 是合成的，模型名 `demo-a` / `demo-b`。条件 7 用 `vi.useFakeTimers()` / `vi.setSystemTime`。

## 现在红在哪（功能还没有）

`node node_modules/vitest/vitest.mjs run --project acceptance <5 个文件>`：

| 文件                    | 结果               | 红的原因                                                                                                                                                     |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mp3-chain.test.ts       | 6 failed           | `resolveModelUseChain` 还不存在（运行时取到 undefined，断言「不是函数」），不是测试写错                                                                      |
| mp3-model-error.test.ts | 4 failed           | `ModelError.status` 还没有，`status` 是 undefined                                                                                                            |
| mp3-config.test.ts      | 10 failed          | `saveModelFallbacks` 还不存在（抛 `NOT_IMPLEMENTED：saveModelFallbacks 还不存在`）；「拒绝」类用例先断言抛出的不是这个标记，避免用「方法不存在」冒充拒绝     |
| mp3-chat.test.ts        | 10 failed          | 同上：`saveModelFallbacks` 不存在即拿不到替补链；四种「不行」与 5 分钟记忆都还没实现                                                                         |
| mp3-analysis.test.ts    | 1 failed, 1 passed | 「第一个 429、第二个正常」红在 `getProvider()` 还没按替补链走（抛 429，拿不到第二个的结果）；「两个都不行 → 抛错」现在也会过（没实现时同样抛），实现后仍应过 |

导入不存在的名字都写成运行时取（`(x as Record<string, unknown>)['name']`），整份文件能起来、红在具体断言，不会因为 import 失败整份挂掉。

## 给整合方/实现方的说明（不是改条件）

- 条件 10 里「连不上/超时没有 status」：`OpenAIChatStreamClient` 与 `OpenAIResponsesProvider` 现在遇到网络错误抛 `ModelError(msg, true)`，加 `status` 时保持不传即可。
- 条件 11 的界面测试按用户看得到的文字与按钮找元素（「用途」卡片里的「上移/下移/删掉/添加/保存」），只复用已有的 `models-uses` / `uses-chat` / `uses-save`；没有新造 data-testid。实现时若换文案要同步这条测试。
- 条件 12 的供应商与替补用 IPC（`saveModelProvider` / `saveModelUses` / `saveModelFallbacks`）配好；「模型」页那套点击在条件 11 已覆盖，避免同一条路测两遍。

## 四项

- 已实现：无（本单只写测试）。
- 自动化通过：无（现在应当红）。
- 真机通过：未跑（实现还没有）。
- 用户接受：未接受。
