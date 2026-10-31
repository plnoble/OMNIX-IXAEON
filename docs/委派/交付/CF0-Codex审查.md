# CF0 审查（Codex 额度用完，由 Claude 代审）

- 时间：2026-10-31T14:38:39.968Z
- 分支：dev/CF0（164b1c6），对照 docs/委派/CF0-聊天先能用.md
- 审查者：Claude（2.1.312）；上下文由脚本喂入（不让审查者跑命令）
- 花费：0.6273257999999999 美元

- 必须改 `packages/contracts/src/modelErrors.ts:33`：`model_not_found` 在取名字的规则之前判定。OpenAI 兼容网关常见的返回是 `{"message":"The model \`x\` does not exist","code":"model_not_found"}`，两种说法同时出现。按现在的顺序会直接返回 `{ model: null }`，说明里写成「这个模型」，界面也拿不到失败的是哪个模型。规格要求的是「是这几种就返回模型名，取不到才为 null」，这里名字明明取得到。应先跑三条带名字的正则，最后再认 `model_not_found`；验收测试也要补一条两种说法同时出现的用例，并重新 lock。
- 必须改 `apps/desktop/src/main/appRuntime.ts:1481`、`packages/contracts/src/ipc.ts:943`（新增的 `setChatModel` IPC）：规格写的是复用现有保存设置的通道，**只有**现有通道必须连同 Key、地址一起传时才新加 `setChatModel`。diff 里的 `saveModelSettings` 签名中 `chatModelName`、`apiBaseUrl`、`apiKey` 都是可选的（「不传 = 保持原值」），看起来不满足新开 IPC 的前提，交付说明也没解释为什么不能用现有通道。二选一：改回用 `saveModelSettings({ modelName, chatModelName })`，或者在交付说明里写清现有通道为什么不行，转整合方确认。（需要人工确认：`saveModelSettings` 的 `modelName` 是否必填、不传 Key 时会不会有副作用。）
- 必须改 `apps/desktop/src/renderer/src/pages/Ask.tsx:416-418`：`retryWithModel` 先 `await api.setChatModel(...)`，再调 `ask(original)`，而 `ask` 在 `busy` 时直接返回。如果另一轮回答正在进行，用户点「用这个模型重问」，结果是聊天模型被悄悄改掉、旧引擎会话被重置（可能打断正在答的那轮），但并没有重问。这是正常使用就能遇到的情况。应在改模型之前判断 `busy`，或者在 busy 时禁用按钮（`AskMessage.tsx` 里 `RetryWithModel` 的按钮）。
- 必须改 `docs/委派/交付/CF0.md:29`：分支里实际提交的交付说明，改动文件统计那一块只写了「（见下）」占位，没有贴 `git diff --stat` 原样输出。和给审查看的版本不一致，交付说明不完整，需要补上再提交。
- 建议 `docs/委派/交付/CF0.md:33`：`contracts/modelErrors.ts +44` 和 diff stat 里的 39 行对不上；按 stat 算源码合计约 285 行，数字应改成实际值。
- 建议 `apps/desktop/src/renderer/src/pages/AskMessage.tsx:275`：失败模型的回退顺序是 `chatModelName ?? m.modelName`。重问换过模型之后，旧失败消息（原文里取不到名字的那种）会把「当前聊天模型」当成失败的模型，下拉框会排错。应优先用这条消息自己记录的 `m.modelName`。
- 建议 `apps/desktop/src/renderer/src/pages/AskMessage.tsx:270-273`：界面判定的依据是 `errorMessage` 里截到 120 字的「原始错误」尾巴。网关原文前缀较长时（比如 Hermes 包了一层），关键字或模型名可能被截掉：说明写着「没有可用渠道」，控件却不出现，或者取到半截模型名。可以考虑在失败消息的 meta 里记下判定结果，或者同时认说明句本身。
- 建议 `apps/desktop/src/renderer/src/pages/Settings.tsx:421-425`：effect 依赖 `[focus, view]`，而 `focus` 用完不清掉。从聊天跳过来之后，设置页每次 `reload()`（比如保存别的设置）都会把页面滚回「模型接入」。应只按 `focus.at` 触发一次，或者滚动后清掉 focus。
- 需要人工确认（交付说明「已知缺口 3」）：没装 Hermes、走 Core 兜底时，下一问仍用分析模型 `modelName`。这时「换个模型重问」会用同一个模型再失败一次，规格「改完之后的下一问用新模型」在这条路径上不成立。是否接受按「照现有路径」处理，请整合方定。

结论：需要修改
