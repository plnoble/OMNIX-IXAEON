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
