# CF0 聊天先能用：模型没渠道时说清是哪个模型、能在聊天里换个已保存的模型重问 交付

- 分支：`dev/CF0`，基于 main `e73ef2d`；档位 A
- 执行方：dev

## 已实现

- `packages/contracts/src/modelErrors.ts`（新）：`isModelUnavailable(detail)` 认规格列的四种说法
  （`No available channel for model <名字>`、`model_not_found`、`The model \`<名字>\` does not
  exist`、`model <名字> not found`，不分大小写），尽量取模型名，取不到回 `{ model: null }`。
- `packages/core/src/runtime/modelErrors.ts`：`explainModelFailure` 在这类失败时改说
  「网关里「<模型名>」现在没有可用渠道（常见原因是那条渠道的套餐或额度失效了）。去网关后台给它
  补一条渠道，或者在聊天里换一个模型重问。」，后面照旧接 `（原始错误：…）`；不再出现
  「稍后再试」。别的 5xx、429、超时、401/403 的说法一个字没动。`isModelUnavailable` 从
  `packages/core/src/index.ts` 一起导出。
- 聊天页（`Ask.tsx` / `AskMessage.tsx`）：失败消息的 `errorMessage` 认出是这类原因时，在失败
  那条下面出「换个模型重问」控件：下拉框只列设置里已检测并保存的 `savedModels`、去掉刚失败的
  那个，按钮「用这个模型重问」。没有别的已保存模型时不出下拉框，改出「设置里还没有别的可用模型」
  和跳到设置页「模型接入」的按钮（`App.tsx` 把设置页滚到那张卡片）。超时、429、别的 5xx 不出
  这个控件。
- `AppRuntime.setChatModel({ model })` + IPC `setChatModel`（preload / `IxaIpcApi` / ipc.ts）：
  只改 `config.model.chatModelName`，复用 `saveModelSettings` 同一条保存路径（会丢掉旧引擎会话，
  下一问用新模型）；模型不在 `savedModels` 里就拒绝、设置不变。重问走和输入框发送同一条
  `askQuestion` 路径，在同一个对话里重发失败回答前面那条用户消息的原话；失败消息不删、不改写。

改动文件与行数（提交后 `git diff --stat origin/main...HEAD` 原样贴）：

```
（见下）
```

源码改动约 270 行（`apps/*/src` + `packages/*/src`：`AskMessage.tsx` +90、`Ask.tsx` +65、
`styles.css` +17、`appRuntime.ts` +19、`App.tsx` +13/−1、`Settings.tsx` +14、`ipc.ts` +2、
`preload/index.ts` +1、`contracts/modelErrors.ts` +44、`contracts/ipc.ts` +5、
`contracts/index.ts` +1、`core/runtime/modelErrors.ts` +17、`core/index.ts` +1/−1），在 300 行以内；
验收测试、真机脚本、交付说明、锁定清单不计入。

和规格不一样的一处：`isModelUnavailable` 的实现放在 `packages/contracts`（core 里再导出）。
原因是聊天页（渲染进程）不能引 `@ixaeon/core`：那会把 better-sqlite3 等主进程依赖打进渲染包。
规格要求的「`packages/core/src/index.ts` 一起导出」照样成立，主进程和界面共用同一份判定。

## 验收测试（v2 规格任务）

- `packages/core/test/acceptance/cf0-model-errors.test.ts`（8 条）——条件 1、2、3：
  条件 1 逐字断言 demo-a / 没有可用渠道 / 换一个模型 / 不含稍后再试，`isModelUnavailable` 回
  `{ model: 'demo-a' }`；条件 2 的 `model_not_found`（取不到名字写「这个模型」）与
  `The model \`demo-b\` does not exist`，另加规格要求 1 里列的 `model demo-c not found`；
  条件 3 对 502 / 429 / 超时 / 401 逐字比对改前的说明，并断言 `isModelUnavailable` 回 null。
- `apps/desktop/test/acceptance/cf0-chat-retry.test.ts`（5 条）——条件 4、5、6、7：
  失败消息下面出现下拉框且选项正好 demo-b、demo-c；选 demo-b 重问后设置改成 demo-b、同一个对话
  多出一问一答、问的是原话、失败消息还是 failed；只有失败的那个模型时不出下拉框、出提示和去设置
  的按钮；超时和 429 两类失败都不出控件。
- `apps/desktop/test/acceptance/cf0-set-chat-model.test.ts`（2 条）——条件 8：传不在
  `savedModels` 里的模型被拒（VALIDATION_FAILED）、设置不变、没落盘；另测正路：传已保存的
  demo-b → `chatModelName` 变成 demo-b、落盘，分析模型 `modelName` 不动。

已用 `node scripts/acceptance.mjs lock CF0 "CF0 聊天先能用：模型没渠道时说清是哪个模型、能在聊天里换个已保存的模型重问" packages/core/test/acceptance/cf0-model-errors.test.ts apps/desktop/test/acceptance/cf0-chat-retry.test.ts apps/desktop/test/acceptance/cf0-set-chat-model.test.ts` 登记指纹。

## 自动化通过

- `node scripts/acceptance.mjs run CF0`：`Test Files 3 passed (3)`、`Tests 15 passed (15)`。
- `node scripts/verify.mjs`：**全部通过，退出码 0**（本机，任务分支 `dev/CF0`，日志 `.logs/verify-cf0.log`）。
  各步：lint、format:check、local-user（1058 个跟踪文件里没有本机账户名）、typecheck、
  typecheck-acceptance、build 都 ✓；unit 13 个文件 69 条 ✓；integration 83 个文件 483 条通过、
  9 个文件 17 条跳过（原有跳过）；acceptance-lock：90 个任务的 177 个锁定验收测试都没被改 ✓；
  acceptance：163 个文件 1271 条 ✓；review 各套件与 4 组真 Electron 界面都 ✓。
- GitHub 上的 verify：**本棒看不到**。接力指令写明「这一棒的推送由调度器替你做：你只提交，不要
  git push」，分支要等本棒结束后才由调度器推上去；本棒按 L15 的做法先在本机跑同一条 `verify.mjs`。

## 真机通过

规格「真机检查 甲」照做：本机起一个合成的 OpenAI 兼容假网关（`demo-a` 回
`HTTP 503: No available channel for model demo-a under group default (distributor)`，`demo-b`
正常回答），设 `IXAEON_DATA_DIR=<临时目录>` 启动构建好的应用。Hermes 用**临时的
`IXAEON_HERMES_HOME`**（里面只有一份合成的 config.yaml，provider 指向假网关），不读也不改用户
Hermes 的 config.yaml / 会话 / 凭据。首次向导和设置页都填假网关地址与合成 Key，检测并保存
demo-a / demo-b / demo-c，聊天模型选 demo-a，问一句；再选 demo-b 点「用这个模型重问」。

脚本：`scripts/real/cf0-chat-retry.mjs`（本机跑，输出原样贴在下面，临时目录/账户名已遮）：

```
FAKE_GATEWAY http://127.0.0.1:49835/v1
SETTINGS_CHAT_MODEL demo-a
截图： D:\Agent\Worktrees\IXAEON\dsh\CF0\.logs\cf0-real\cf0-1-model-unavailable.png
FAILURE_TEXT 失败：这一轮没答完：网关里「demo-a」现在没有可用渠道（常见原因是那条渠道的套餐或额度失效了）。去网关后台给它补一条渠道，或者在聊天里换一个模型重问。（原始错误：HTTP 503: No available channel for model demo-a under group default (distributor)） demo-b demo-c 用这个模型重问 引擎 ask · 模型 —
RETRY_OPTIONS ["demo-b","demo-c"]
截图： D:\Agent\Worktrees\IXAEON\dsh\CF0\.logs\cf0-real\cf0-2-retry-answered.png
FAILED_MESSAGE_STILL_THERE 1
SAME_QUESTION_TIMES 2
GATEWAY_REQUESTS [{"model":"demo-a","stream":true},{"model":"demo-a","stream":false},{"model":"demo-a","stream":false},{"model":"demo-a","stream":true},{"model":"demo-a","stream":false},{"model":"demo-a","stream":true},{"model":"demo-b","stream":true},{"model":"demo-b","stream":false},{"model":"demo-a","stream":true},{"model":"demo-a","stream":true}]
RESULT 通过：没渠道说清了 demo-a、失败下面能换 demo-b 在同一个对话里重问出答案，失败消息仍留着
```

截图（合成数据，已遮掉临时目录）：

1. 失败说明和换模型控件：`docs/委派/交付/cf0-1-model-unavailable.png`
2. 换 demo-b 重问后答出来、失败消息还在：`docs/委派/交付/cf0-2-retry-answered.png`

![失败说明和换模型控件](cf0-1-model-unavailable.png)

![换 demo-b 重问后答出来](cf0-2-retry-answered.png)

**乙（用户做）：待用户实测。** 用户在自己的网关里补好渠道或换好模型后，在 IXAEON 里问通一句，
才算这一条的乙通过；本棒没碰用户的真实网关和 Hermes 配置，不能写成已通过。

## Codex 审查（A 档）

（待审查；结论写进 `docs/委派/交付/CF0-Codex审查.md`。）

## 已知缺口

1. 分支的 GitHub verify 在本棒看不到（调度器棒末才推）；本机 `verify.mjs` 与 CI 是同一条命令。
2. 真机甲的聊天是**真 Hermes + 合成 config.yaml + 假网关**，不是用户自己的网关；乙仍待用户。
3. 聊天模型切换只影响 Hermes 那条路（`chatModelName` 传给 Hermes）。没装 Hermes 时走
   Core 有界兜底，兜底用的 provider 仍是分析模型 `modelName`（`getProvider()`），所以在那种
   情况下「换个模型重问」换的是 Hermes 用的模型，下一问的 Core 兜底仍会用分析模型。规格契约
   写的是「现有改聊天模型的路径怎么让 Hermes 换模型，照它来」，本棒按这条做，没有扩大改动。
4. 真机日志里 `demo-b` 答完后还有几次 `demo-a` 请求（Hermes 的辅助任务，例如生成标题，仍用
   config.yaml 的默认模型）；主对话不受影响，但辅助任务在 demo-a 没渠道时也会失败，属于 Hermes
   自己的辅助模型选择，不在 CF0 范围。
5. 条件 6 的去设置按钮只在界面测试里验了「按钮在、点了回调」：`App.tsx` 切到设置页并把设置页
   滚到「模型接入」是这次一起加的，严格意义上的滚动位置没有断言（jsdom 没有布局）；
   真机甲没有走这条路径（假网关里还有别的模型）。
6. `setChatModel` 的测试落在 `AppRuntime` 方法上；IPC 注册和 preload 暴露各是一行接线，没有
   单独的通道测试。

## 用户接受

未发生（用户用过并认可之后才写）。