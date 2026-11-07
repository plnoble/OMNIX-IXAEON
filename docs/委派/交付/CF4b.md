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
