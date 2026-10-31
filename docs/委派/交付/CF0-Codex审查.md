# CF0 审查（Codex 额度用完，由 Claude 代审）

- 时间：2026-10-31T15:04:24.267Z
- 分支：dev/CF0（42537a5），对照 docs/委派/CF0-聊天先能用.md
- 审查者：Claude（2.1.312）；上下文由脚本喂入（不让审查者跑命令）
- 花费：0.529453 美元

- 建议 `apps/desktop/test/acceptance/cf0-chat-retry.test.ts:14-17`：开头注释的「钉住的接缝」还写着「重问 = 先 `api.setChatModel({ model })`」。实现和测试实际走的都是 `saveModelSettings`，注释过期，和交付说明对不上。改正后重新 `lock`。
- 建议 `apps/desktop/test/acceptance/cf0-chat-retry.test.ts:262-290`：条件 5 断言了 `saveModelSettings` 和 `askQuestion` 各调一次，但没断言先后顺序。规格要求「先改聊天模型，再重问」，可以用 `mock.invocationCallOrder` 把顺序钉住（只是改严）。
- 建议 `apps/desktop/src/renderer/src/pages/Ask.tsx:418-432`：`retryWithModel` 先 `await saveModelSettings`，`ask()` 里才 `setBusy(true)`。保存还没返回时连点两下，两次闭包里的 `busy` 都是 false，同一句原话会发两遍。可以在保存前就置一个本地的进行中标记。
- 建议 `packages/contracts/src/modelErrors.ts:29`：`NOT_FOUND` 规则 `\bmodel\s+NAME\s+not found` 会把 "The requested model was not found"、"model is not found" 里的 `was`、`is` 当成模型名。结果是说明写成「网关里「was」…」，下拉框也排除不掉真正失败的那个模型。可以加个排除常见虚词的约束，或者要求名字里带 `-`、`/`、`.`、数字之一。
- 建议 `docs/委派/交付/CF0.md:33-53`：贴的 stat 是 17 个文件，含 `CF0-Codex审查.md`（18 行）、`CF0.md` 161 行；实际分支是 16 个文件，没有 `CF0-Codex审查.md`，`CF0.md` 是 183 行。按最终提交重贴，并确认第 1 轮审查结论文件为什么不在分支里。AGENTS.md 要求 `CF0-Codex审查.md` 随分支提交，本轮结论写进去时要一并提交。
- 需要人工确认：现有 `saveModelSettings` 只传 `{ modelName, chatModelName }`、不带 `apiKey`、`apiBaseUrl`、`savedModels` 时，主进程不会清空 Key、地址或已保存模型清单，也不会触发额外的网络请求。diff 里看不到主进程实现，测试里的 mock 也替它回了 `keyCleared: false`。真机甲的 Hermes 读的是自己的合成 config.yaml，证明不了这一点。如果会清空，就是必须改。
- 需要人工确认：两张提交进公开仓库的截图（`cf0-1-model-unavailable.png`、`cf0-2-retry-answered.png`）里没有本机账户名、临时目录路径或其他真实数据。diff 只给了二进制，看不到内容。

结论：可以合并
