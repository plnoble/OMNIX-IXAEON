# CF4b 交付说明：讨论转任务（界面部分，基于 dev/CF4）

规格 `docs/委派/CF4-讨论转任务.md` 条件 10。本支只含界面。

## 已实现

- `AskMessage.tsx`：complete 助手消息下「转成任务」按钮 + 展开表单（范围下拉、目标预填前 2000 字、验收条件一行一条、个人视角选项目）、建完显示「已转成任务：<前 30 字>」与「到任务页看」；列表用 `useEffect` 读一次，不在渲染期 setState。
- `Tasks.tsx`：任务卡片显示「来自对话「标题」第 a–b 条」（标题从 tasks 或对话列表回退取）、「来自已删除的对话」；`onOpenConversation` 打开对话。
- `App.tsx`：给 TasksPage 接 `onOpenConversation` → 设 `openConversationId` 并切到聊天页。
- `Ask.tsx`：把 messages / conversationId / 项目 / projects 传给消息组件。

## 自动化通过

```
$ node node_modules/vitest/vitest.mjs run --project acceptance apps/desktop/test/acceptance/cf4-ui.test.ts
Tests  9 passed (9)
```

`tsc`、`eslint` 干净。核心条件 1–9 在 `dev/CF4` 支（28 条）。

## 真机通过

与 CF4 同一次真机检查（`scripts/real/cf4-task-origin.mjs` 在 CF4 支）：任务页显示「来自对话」true，范围 1–4、draft、消息 4 条、审计 1 行；脚本断言不符即非 0 退出，截图前断言页面文本不含临时目录。

## 用户接受

未接受。

## 整合方复审（2026-11-07，由 DSH + group/ixaeon-integrator 代做）

结论：**退回，不并。** 先并 CF4 是前提，CF4 也退回了（见 `docs/委派/交付/CF4.md` 同名一节，在 dev/CF4 上）。

- 核过：App 已给 `TasksPage` 接 `onOpenConversation`（切到聊天页并打开那段对话）；`AskMessage.tsx` 的任务列表改成 `useEffect`，按 `conversationId` 重读，不再在渲染期发请求；任务页来源三种情况（有标题、对话已删、手建不显示）都有。
- **没处理**：规格「要什么」1 和代审条件 10 要的「范围（可修改的路径）默认 `.`、可改」。`AskMessage.tsx:544` 提交时仍写死 `scope: ['.']`，表单里没有路径输入。要加输入框（默认 `.`，空了不能提交），按输入传 `scope`，补一条界面测试（不改锁定的 `cf4-ui.test.ts`）。
- 测试：本支 `node node_modules/vitest/vitest.mjs run --project acceptance apps/desktop/test/acceptance/cf4-ui.test.ts` 9/9 通过；文件和 main 上锁定的逐字相同；eslint 干净。
- 锁定：已在 main 上 `node scripts/acceptance.mjs lock CF4b "讨论转任务（界面）" apps/desktop/test/acceptance/cf4-ui.test.ts`（状态 queued，指纹不变）。
- 源码 248 行，没超 300。
- CI：没合并，本支 CI 结果不作数。改完后 `git merge dev/CF4`（CF4 改完并 merge 过 main 之后），再推。

## 整合方复审（2026-11-07，由 DSH + group/ixaeon-integrator 代做）

第二次看，只做整合，没改实现和测试。

- 核了：dev/CF4b 1ba0a4a（表单加「可修改的路径」输入）上 `node node_modules/vitest/vitest.mjs run --project acceptance apps/desktop/test/acceptance/cf4-ui.test.ts` 9/9 通过。
- 同步：CF4 并入 main 后，在 dev/CF4b 上 `git merge origin/main`（808d492，无冲突，没 rebase），推到 dev/CF4b；合并后 CF4 + CF4b 两份锁定测试 37/37 通过。
- 合并：`git merge --no-ff origin/dev/CF4b` 进 main（cfe864d），本机 `node scripts/verify.mjs` 退出码 0。
- CI：main 上 run 42347444949 success（15m26s）。
- `node scripts/acceptance.mjs done CF4b`（CF4b 的锁定单独一条，不 done 就不进门禁）。
- 真机：本轮没重跑；截图遮蔽仍未由能读图的整合方核过。
