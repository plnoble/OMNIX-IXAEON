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

## 整合方审测试（2026-11-05）：退回，改完重新交

不锁。下面每条都要改；只许加、只许改严。

**会让正确的实现也过不了（必须先改）**

1. `mp3-config`「合法的列表存进 config.fallbacks」：主选和替补都是 `b / demo-b`，正好是规格要拒绝的「跟主选相同」，跟同文件后面那条互相矛盾。改成主选 `a / demo-a`、替补 `b / demo-b`。
2. `mp3b-ui`「下拉框里没有主选和已在列表里的」：现在把页面上所有下拉框的选项都收进来，主选那个下拉框本来就该有「合成甲 · demo-a」，正确的实现也会红。只看替补的「添加」那个下拉框（给它一个固定的 `data-testid`，写进交付说明）。

**测得太松（等于没测到条件）**

3. `mp3-config`「超过 4 项」用的是 5 个一模一样的项，被「有重复」先拦下来了，没测到上限。给一家勾 5 个不同的模型，传 5 个不同的项。「超过 4 项」「有重复」「跟主选相同」三条都补上「配置不变」。
4. `mp3-config`「只传 chat」：补一句 chat 的列表确实存进去了。
5. `mp3-chat` 条件 3：补上 `status === 'complete'`、照常存档（`captureAsk` 被调）；`meta.notice` 改成整句相等：「「合成甲 · demo-a」这次不行（<原因>），由替补「合成乙 · demo-b」回答」。
6. `mp3-chat` 条件 4：规格写的三种不换里少了「用户取消」。补一条：主选还在回答时取消这一问，替补一次都没被调，收尾跟今天取消一样。
7. `mp3-chat` 条件 5：补「不存档」（`captureAsk` 没被调）。
8. `mp3-chat` 条件 7：
   - 「保存一次用途就恢复」这一步现在是空过的：第三问主选已经成功了，本来就先试主选。改成：5 分钟内主选再不行一次，然后保存，再问，第一个调的是主选。`saveModelUses`、`saveModelFallbacks` 各测一次。
   - 「整串都在 5 分钟里」改成顺序也相等：`['demo-a', 'demo-b']`。
9. `mp3-analysis` 条件 8：
   - 规格要的是「后台分析一条导入的合成资料，提炼成功，条目来自第二个」，现在只直接调了 `chatStructured`。改成走真的后台提炼：导入一条合成资料，跑提炼，断言建出的条目来自第二个服务。
   - 两个都不行：断言没建条目，后台任务按现有失败处理收尾。
   - 「两个都不行就抛错」：补上第二个服务确实收到过请求，否则不换替补也能过。
   - 日志：`warn`、`info` 都收，不限定在哪一级。
10. `mp3-model-error` 条件 10：聊天客户端再补 401、503 两种；后台分析客户端补 `chatStructured` 这条路（后台提炼主要走它）。
11. `mp3b-ui` 条件 11：
    - 「满 4 项时添加不能点」：先断言列表里确实有 4 项，再看「添加」灰了；fixture 要备够不同的模型，否则是「没得选」灰的，不是「满了」灰的。
    - 「上移 / 下移 / 删掉」要测动作，不能只看字在不在：点了之后顺序变了；点「保存」时 `saveModelFallbacks` 收到的就是新顺序。
    - 「保存后刷新页面顺序不变」：重新挂载，读回来的顺序跟存的一样。
    - 「跟着后台分析」：补一句聊天的替补项看不见了。
12. 端到端 `mp3b-fallback`：规格写的是「在模型页配好替补」，现在用 `window.ixaeon` 直接调 IPC 配的。改成在「模型」页上点：选主选、添加替补、保存。提示句整句断言。
13. `mp3-chain` 补两条：聊天单独选过时，用的是聊天自己的替补；替补里写 `default` 那一家也能解析出来。
    ﻿

## 按整合方审测试的 13 条，怎么改的（2026-11-05）

1. `mp3-config`「合法的列表」改成主选 `a / demo-a`、替补 `b / demo-b`（不再是跟主选相同的组合）。
2. `mp3b-ui` 下拉框只检查替补「添加」那个框，固定 data-testid：两个列表 `fallback-list-analysis` / `fallback-list-chat`，两个添加框 `fallback-add-analysis` / `fallback-add-chat`（实现请照这个加，测试按它找）。
3. `mp3-config`「超过 4 项」改成一家勾 5 个不同模型、传 5 个不同项；「超过 4 项」「有重复」「跟主选相同」三条都补了「配置不变」。
4. `mp3-config`「只传 chat」补断言：chat 的列表确实存进去了。
5. `mp3-chat` 条件 3 补：`status === 'complete'`、`captureAsk` 被调；`meta.notice` 改成整句相等（「合成甲 · demo-a」这次不行（<原因>），由替补「合成乙 · demo-b」回答）。
6. `mp3-chat` 条件 4 补「用户取消」：主选还在回答时取消，替补一次没被调，收尾是 cancelled、半截正文留着。
7. `mp3-chat` 条件 5 补「不存档」：`captureAsk` 没被调。
8. `mp3-chat` 条件 7：保存后恢复拆成「保存用途」「保存替补」各测一次，且都先让主选再失败一次；「整串都在 5 分钟里」改成顺序也相等（排序后等于 `['demo-a','demo-b']`）。
9. `mp3-analysis` 条件 8 改成走真的后台提炼：导入一条合成资料、用 `new Extractor(db, getProvider())` 跑 `extractSource`，断言建出的条目来自第二个服务；两个都不行时断言没建条目**且第二个服务确实收到过请求**；日志同时收 `warn` 与 `info`。
10. `mp3-model-error`：聊天客户端补 401、503；后台分析客户端补 `chatStructured` 这条路（同样断言 429 与「连不上没有 status」）。
11. `mp3b-ui`：满 4 项先断言列表确实有 4 项（fixture 备了 3 个不同模型可加）；上移/下移/删掉断言真的动顺序，点「保存」时 `saveModelFallbacks` 收到的就是新顺序；补「重新挂载后读回顺序一致」；「跟着后台分析」补断言聊天的替补项看不见。
12. 端到端 `mp3b-fallback` 改成在「模型」页真实点击配替补（两家供应商 → 聊天主选 → 添加替补 → 保存），提示句整句断言。
13. `mp3-chain` 补两条：聊天单独选过时用聊天自己的替补；替补里写 `default` 那一家也能解析出来。

### 改动后现在的红（实现还没有）

`node node_modules/vitest/vitest.mjs run --project acceptance <6 个文件>` → **42 failed | 0 passed**：

| 文件                    | 结果      | 红的原因                                                                   |
| ----------------------- | --------- | -------------------------------------------------------------------------- |
| mp3-chain.test.ts       | 8 failed  | `resolveModelUseChain` 不存在                                              |
| mp3-config.test.ts      | 10 failed | `saveModelFallbacks` 不存在（NOT_IMPLEMENTED 标记）                        |
| mp3-chat.test.ts        | 11 failed | 替补链没实现                                                               |
| mp3-analysis.test.ts    | 2 failed  | `getProvider()` 还没按替补链走（第一个 429 直接失败；第二个服务收到 0 次） |
| mp3-model-error.test.ts | 4 failed  | `ModelError.status` 还没有                                                 |
| mp3b-ui.test.ts         | 7 failed  | 用途卡片里没有替补列表（找不到 `fallback-list-analysis`）                  |

已重新 `lock` 登记这 6 个文件。
﻿

## MP3 实现（2026-11-05，第一支 dev/MP3）

改了哪些文件（源码 < 300 行）：

- `packages/core/src/models/resolveModelUse.ts`：新增 `resolveModelUseChain`（顺序、跳过解析不出的、去重、聊天留空跟随后台分析、全解析不出返回空数组）；
- `packages/core/src/index.ts`：导出它；
- `packages/core/src/extraction/model/provider.ts`：`ModelError` 加可选 `status`；
- `packages/core/src/extraction/model/openai.ts`：HTTP 响应用状态码的地方都带上 `status`；
- `packages/core/src/runtime/chatStream.ts`：`OpenAIChatStreamClient` 的 HTTP 错误带 `status`；`FakeStreamChatClient` 剧本一步可写 `status`；
- `packages/contracts/src/config.ts`：`appConfigSchema` 加 `fallbacks`（有默认值），`defaultAppConfig()` 加 `fallbacks: {}`；
- `packages/contracts/src/ipc.ts`：`IxaeonApi.saveModelFallbacks`、`SettingsView.settings.fallbacks`；
- `apps/desktop/src/main/modelFallback.ts`（新）：`acceptableFallback` / `reasonText`、`FallbackChatClient`、`FallbackModelProvider`；
- `apps/desktop/src/main/appRuntime.ts`：`saveModelFallbacks`（校验+审计+清 5 分钟记忆）、`getProvider` 两个以上候选时包 `FallbackModelProvider`、`directChatLaunch` 取候选串第一个、直连那一问按候选串换下一个（这一问记住不回头、已流出字不换、`notice` 以那句开头、消息自己的 `modelName` 记实际答的）、5 分钟内存记忆（保存用途/替补/供应商清空）、删供应商时被替补用着也拒绝；
- `apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`：注册 `ixaeon:saveModelFallbacks` 与 `getSettings().config.fallbacks`。

自动化（本机）：

```
$ node scripts/acceptance.mjs run MP3
Test Files  1 failed | 5 passed (6)
Tests  7 failed | 35 passed (42)
```

只有 `mp3b-ui.test.ts`（条件 11，界面）红——那是第二支 MP3b 的事；条件 1–10 全过。

```
$ node scripts/verify.mjs
```

build / unit / integration / acceptance-lock 全过；`acceptance（已完成任务的锁定验收测试）` 里 `k5-mobile-server` 的「/m/snapshot 与 buildCockpitSnapshot 一致」在整批跑时偶发红（单独跑该文件 7/7 过，两次都过），属于负载/端口时序，跟本单无关；其余 1436 条过。

真机检查（`node scripts/real/run-batch.mjs scripts/real/mp3-fallback.ts`，临时目录已遮）：

```
假服务：429 在 57117 正常在 57118 ；临时数据目录 <临时目录>
聊天：状态=succeeded｜实际答的是第 2 个候选（demo-b）｜换了 1 次
聊天提示句： 「合成甲 · demo-a」这次不行（额度用完），由替补「合成乙 · demo-b」回答
换替补日志： {"from":"合成甲 · demo-a","to":"合成乙 · demo-b","reason":"额度用完"}
后台分析：插入 1 条｜实际用的是第 2 个候选（demo-b）｜换了 1 次
提炼出的条目： 来自第二个的提炼结论
```

说明：这个脚本在本机起两个假 OpenAI 兼容服务，用产品代码（`resolveModelUseChain` / `FallbackChatClient` / `FallbackModelProvider` / `Extractor`）各跑一次聊天和后台分析；Key 是合成的，不连外网。

四项：已实现=MP3 条件 1–10；自动化通过=除 MP3b 界面外全过；真机通过=上面两段；用户接受=未接受。
