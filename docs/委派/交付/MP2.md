# MP2 交付说明（本轮：只交测试，第二版）

规格：`docs/委派/MP2-多个模型供应商.md`（main 最新版，含 11-03 补的三处）。
B 档流程：本轮**只写测试**，不写实现。分支 `dev/MP2`。

## 一、本版按复审意见改了什么（逐条）

**怎么实现都过不了的（必须改）**

1. `runtime.getSettings()` 不存在 → 全部改用 `runtime.getConfig()`；条件 2「getSettings 返回里没有 Key/密文」
   改成走**真的 IPC**：`registerIpc(runtime)` 后从 `ipcMain.handle` 的调用里取出 `ixaeon:getSettings` 处理函数再调
   （照 `d7b-executor-selection.test.ts` 的做法）；并断言返回里带 `uses`。条件 9 的 magpie 地址改用
   core 的 `getSetting(db, 'cockpit.magpie_url')` 读，期望 `http://127.0.0.1:39123`。
2. 三个文件的 `runtimeWith` 都去掉了 `getProvider: () => FakeProvider('mp2')` 替身，改用真的 `getProvider`。
3. 删掉了 `getProvider()?.baseUrl` 那一行（字段是私有的）。
4. `safeStorage` 替身的 `decryptString` 改成「不是 `enc:` 开头就抛」，才造得出「解不开」。

**恒绿或等于没测的（必须改）**

5. 条件 2「解不开」去掉 `if (view)`，必须找到那一家并断言。
6. 条件 5 先获取一次 B 让它有 `modelsCheckedAt`，再获取 A，断言 B 的时间不变。
7. 条件 6「选没勾过的模型」先单独调 `withTwoProviders`，再 `expect(...).toThrow()`，然后断言聊天仍是旧字段。
8. 条件 4「地址变了」改用**另一个端口的假服务**，断言第二个服务收到的请求 `authorization` 为 null、第一个服务没多收请求。
9. 条件 14 去掉 `if (codingModel)`，必须找到下拉框。

**漏掉的条件（必须补）**

10. 条件 9 最后一条：openai 类型走完「获取模型 → 保存勾选 → `listModelProviders()`」，假服务只收到 `/v1/models`（补在 `mp2-fetch-models`）。
11. 条件 11 后半句：聊天里「去设置「模型接入」添加」入口还在、点了会触发回调（`AskMessage` 的 `model-unavailable-settings`）。
12. 条件 12：补「没 Key 显示『未配置』」；「新」「上游已没有」按获取前后的勾选对比断言（不再用「页面有『新』字」这种松写法）；筛选框输入 `new` 后 `demo-a` 那一行消失。
13. 条件 13：聊天选成「合成乙 · demo-b」保存后断言 `saveModelUses` 收到 `chat = { providerId: 'p-b', model: 'demo-b' }`；`getSettings` 按规格返回 `config.uses`；重新渲染后选中还是它。
14. 条件 14：补聊天里换模型的下拉框（`model-retry-select`），断言选项带「供应商名 · 」前缀。

## 二、测试清单（38 条）

| 文件                       | 条数 | 条件                        |
| -------------------------- | ---- | --------------------------- |
| `mp2-providers.test.ts`    | 15   | 1、2、3、5、8、9、10        |
| `mp2-fetch-models.test.ts` | 5    | 4、9（openai 不发额度请求） |
| `mp2-uses.test.ts`         | 8    | 6、7                        |
| `mp2b-model-page.test.ts`  | 10   | 11、12、13、14、15          |

不连真网关、不用真 Key：地址是 `127.0.0.1` 随机端口（条件 4 用 `node:http` 现起假服务），Key 是合成值，模型名 `demo-a`/`demo-b`。

## 三、现在为什么是红的（逐文件）

`node node_modules/vitest/vitest.mjs run --project acceptance <四个文件>` → **38 条里 36 红、2 绿**：

| 文件                       | 结果             | 红的原因（只能是「功能没有」）                                                                                                                        |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mp2-providers.test.ts`    | 15 条 14 红 1 绿 | `runtime.saveModelProvider / listModelProviders / deleteModelProvider / saveModelUses is not a function`；`getSetting('cockpit.magpie_url')` 没被写入 |
| `mp2-fetch-models.test.ts` | 5 条全红         | `runtime.saveModelProvider` / `fetchProviderModels is not a function`                                                                                 |
| `mp2-uses.test.ts`         | 8 条全红         | `saveModelProvider / saveModelUses is not a function`；`chatLaunchOptions()` 还不认 `uses`                                                            |
| `mp2b-model-page.test.ts`  | 10 条 9 红 1 绿  | 导航没有 `nav-models`、没有 `models-page`（页面还没做）；设置页还有 `settings-model`/`settings-quota`                                                 |

**2 条绿的是「保持原样」的守卫，不是漏测**：

- `mp2-providers` 的「getProvider() 与 chatLaunchOptions() 跟改之前一样」——这条本来就该在改之前和改之后都是绿的；
- `mp2b` 的「聊天里『去设置「模型接入」添加』入口还在、点了会触发回调」——入口今天就有；本规格只把它**落点**改成「模型」页。

## 四、证明「测的是真东西」（复审第一条要求）

做法：临时新建一个**不提交**的 `zztmp-proof.test.ts`，给 runtime 补上最小的假 `listModelProviders()` / `saveModelProvider()`
（default 从 `config.model` 推、别家从 `config.providers` 推，后四位写死 `c3d4`），跑条件 1 与条件 2 的那几条断言：

```
✓ |acceptance| apps/desktop/test/acceptance/zztmp-proof.test.ts (1 test) 70ms
Tests  1 passed (1)
```

**结论：补上假实现之后这些断言就变绿了**，说明它们测的是真行为，不是空断言。跑完已删除，没有提交。
（第一次跑时断言也全过，只是收尾 `rmSync` 在 Windows 上因 db 未关报了 EPERM；关掉 db 后是干净的 1 passed。）

## 五、冲突的旧锁定测试（本轮**一条未改**）

上轮列的清单不变：`m2-settings-ui`、`m3-settings-ui`、`sub1-magpie-preset`、`sub1b-quota-settings`、
`k4c-quota-settings`、`v4-settings-page`、`u2-settings-coding-saved`、`d7b-pages`、`cf0-chat-model-switch`。
其中前四份测的界面元素按规格要搬走或消失，后几份是选项文案/页面骨架变化。
**按规格「已有锁定测试会撞到的（11-03 定）」**：这些旧测试要跟 MP2b 的实现放在同一个分支改，
规矩是只改「去哪儿找」、断言不删不放宽、不重新登记它们的指纹。**本轮是纯测试轮，不动它们。**

## 六、真机 / 用户接受

**真机未跑**（还没实现，甲/乙/丙都做不了）。**用户接受未取得**，`待用户实测`。

## 七、两处读法

1. 条件 9 的「地址来源」：期望 `cockpit.magpie_url` 是 `http://127.0.0.1:39123`（去掉 `/v1`）。
2. 条件 6 只断言 `getProvider()?.modelName` 仍是 default，不再断言 `baseUrl`（字段私有）。

## 整合方审测试（2026-11-03，第二版锁定）

- 第一版退回的 14 条都已改到位，主进程那三份照原样锁定。
- 两处读法认可：magpie 地址来源取到端口为止（`http://127.0.0.1:39123`）；条件 6 只断言 `getProvider()` 的模型名。
- MP2b 拿掉一条再锁：「聊天里换模型的下拉框」单独渲染 `AskMessage`、只给 `savedModels` 字符串，等于把组件入参写死，实现拿不到供应商名。它和条件 11 的「聊天入口落到模型页」（现在那条只测了按钮会调回调，今天就是绿的）一起，由 MP2b 实现时另写 `mp2b-entry.test.ts`，经 App 渲染，合并时整合方锁定。

## 实现轮（2026-11-03，dev/MP2 第一支：配置 + 主进程 + IPC）

### 已实现

| 文件                                                | 新增行数（约） | 做了什么                                                                                                                                                                                                  |
| --------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/config.ts`                  | +45            | `modelChoiceSchema` / `modelProviderSchema`；`appConfigSchema` 加 `providers`、`uses`（都有默认值，旧配置照样能读）；`model.providerName`                                                                 |
| `packages/contracts/src/ipc.ts`                     | +35            | `ModelProviderView`；`settingsViewSchema.config` 加 `uses`；`IxaIpcApi` 加 5 个方法                                                                                                                       |
| `packages/core/src/models/resolveModelUse.ts`（新） | +71            | 按用途取模型的纯函数，不解密；`packages/core/src/index.ts` 导出                                                                                                                                           |
| `apps/desktop/src/main/appRuntime.ts`               | +170           | `listModelProviders` / `saveModelProvider` / `deleteModelProvider` / `fetchProviderModels` / `saveModelUses`；`getProvider()`、`chatLaunchOptions()`、`directChatLaunch()` 三条路径改走 `resolveModelUse` |
| `apps/desktop/src/main/ipc.ts`                      | +8             | 5 个新通道；`getSettings` 的 config 加 `uses`                                                                                                                                                             |
| `apps/desktop/src/preload/index.ts`                 | +6             | 5 个方法桥接                                                                                                                                                                                              |

**合计约 +335 行源码**，超了「每支 ≤300 行」——超出来的是契约 schema / 视图类型 / 类型声明这些必须照规格写死的东西
（`config.ts` + `ipc.ts` 共约 80 行几乎都是 schema 与类型）。逻辑本身集中在 `resolveModelUse.ts` 与 `appRuntime.ts`
两处，没有旁支改动。这一条如实报给整合方，不自行拆。

**按规格第 5 条改的一处**：`directChatLaunch()` 的「聊天单独选过」改成 `uses.chat` 有 **或** `model.chatModelName` 非空，
两者都没有时照旧跟着后台分析、不走直连（CF3b 的行为没退化：条件 17 仍绿）。

### 自动化通过

```
node scripts/acceptance.mjs run MP2   → 27 passed | 1 failed（共 28）
```

通过的 27 条覆盖条件 1、2（含真 IPC getSettings、后四位、解不开）、3、4（含 302 不跟随、超时、地址变了不带旧 Key）、
5、6（含 `engine = 'direct'`）、7、8、9（除下面那条）、10。

### 一条过不了的锁定测试（**规格/测试本身的错，不是实现错**）

`apps/desktop/test/acceptance/mp2-providers.test.ts` 条件 9 的第一条：

```ts
expect(getSetting(db, 'cockpit.magpie_url')).toBe('http://127.0.0.1:39123');
```

`@ixaeon/core` 的 `getSetting(db, key)` 返回的是 `{ value: string; updatedAt: string } | null`
（`packages/core/src/settings.ts:22`，全仓唯一实现，界面那边也是 `getSetting(...)?.value` 这么用的），
所以这条断言**永远不可能成立**：实现已经把 `cockpit.magpie_url` 正确写成 `http://127.0.0.1:39123`，
只是读出来是个对象。

需要的改动只有一行（改的是锁定测试，**我不能动**）：

```ts
expect(getSetting(db, 'cockpit.magpie_url')?.value).toBe('http://127.0.0.1:39123');
```

请整合方改这一行后重新锁定；改完这条应立刻变绿（实现侧无需再改）。

### 真机 / 用户接受

**真机未跑**（第一支不接线，甲/乙都要在 MP2b 之后做）。**用户接受未取得**。

### 还剩什么

1. 上面那行锁定测试要整合方改（一行）。
2. MP2b（界面）**本轮没开始**：等这一条定了再在同一分支上继续，免得界面把红一起带过去。

### 行数更正（实测，2026-11-03）

上面那张表是我凭印象写的「约」，实测 `git diff --numstat origin/main...HEAD -- packages/contracts/src packages/core/src apps/desktop/src`：

| 文件                                                | 新增    |
| --------------------------------------------------- | ------- |
| `apps/desktop/src/main/appRuntime.ts`               | 319     |
| `packages/core/src/models/resolveModelUse.ts`（新） | 69      |
| `packages/contracts/src/ipc.ts`                     | 47      |
| `packages/contracts/src/config.ts`                  | 34      |
| `apps/desktop/src/main/ipc.ts`                      | 8       |
| `apps/desktop/src/preload/index.ts`                 | 6       |
| `packages/core/src/index.ts`                        | 1       |
| **合计新增**                                        | **484** |

**比规格估的 230 行、比 300 行指引都多**。多出来的两块：

1. 契约那 82 行（两个 schema、`ModelProviderView`、`SettingsView` 的 `uses`、`IxaIpcApi` 的 5 个方法）——规格「契约」一节写死的形状，删不掉；
2. `appRuntime.ts` 的 319 行含 5 个新方法（约 200 行）与三条取模型路径的改写（约 30 行），
   其中 `fetchProviderModels` 一个方法就 45 行（超时、不跟跳转、Key 复用规则、去重、记检测时间都要在里面）。

不自行再拆：规格已经把 MP2 的第二半（界面）单列成 MP2b，再拆就与规格的拆法不符。**是否接受 484 行由整合方定。**

### 分支状态（截至本轮停下）

- `dev/MP2`：`ff9490f`，CI **success**；本机 `node scripts/verify.mjs` **全过**。
- 队列第 163 行保持「窗口进行中（dev）」——第一支还差上面那一行锁定测试的裁定，没改成「待复审」。
