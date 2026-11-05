# MP3e 交付说明（收尾中，端到端还差一句展示）

分支 `dev/MP3e`，基于 `dev/MP3db`。

## 已实现

- `DshExecutor`（`packages/core/src/execution/toolLaunch.ts`，`name: 'dsh'`，经 `dshLaunch` 起桌面版、取最后一行 `final`）。
- 「模型」页「编码任务」主选 + 替补列表：`coding-chain-list`、`coding-chain-add` 与四个下拉（`coding-chain-kind` / `coding-chain-tool` / `coding-chain-claude-model` / `coding-chain-provider`），选项文字与「没找到」标记照规格；上移 / 下移 / 删掉；保存时 `saveCodingChain` 收到新顺序；满 5 项「添加」禁用。
- 收尾时修的三处真问题：
  1. `getSettings().config` 没有暴露 `codingChain` → 界面读不回、端到端也读不到；已补进契约与主进程。
  2. `saveUses` 原来先存 uses 再存替补最后存编码候选，第一步因「模型没勾选保存过」抛错就永远存不到链；改成 **先存编码候选**，再存 uses / 替补，出错照原样显示。
  3. `ClaudeCodeExecutor` / `DshExecutor` 的回报缺 `changedPaths`，编排层对它 `.map` 直接崩（端到端里的 `Cannot read properties of undefined (reading 'map')`）；已补 `changedPaths: []` 与 `testsModified: false`。

## 自动化

- `mp3e-coding-chain-ui.test.ts`：**4/4 过**；`tsc` 0；`node scripts/build.mjs` 通过。
- `node scripts/test-e2e.mjs desktop`：**24 passed / 1 failed**。
- 端到端现在已真正走候选串：任务卡显示 `执行器 claude-code`、`改了 1 个文件`（假 Codex 额度用完 → 换到假 Claude 写文件），但卡片上看不到「「Codex」这次不行（额度用完），由替补「Claude Code · sonnet」来做」这句话，所以 `toContainText` 仍红。

## 卡在最后一处（下一步）

`CodingTaskView` / 任务卡没有暴露执行报告的 `summary`（`Tasks.tsx` 只在失败时显示 error）。要让条件 15 转绿，需在任务视图加执行摘要字段并渲染到卡片；这是新增字段，涉及契约与 UI，留待下一轮或请整合方定字段名。

## 真机通过

- 界面截图：未做。
- 「Codex → DSH」假程序那一串：未做（`DshExecutor` 已就绪，脚本可照 `scripts/real/mp3d-coding-chain.ts` 加一条）。

四项：已实现=DSH 执行器、编码任务界面、三处真问题修复；自动化通过=UI 4/4、e2e 24/25；真机通过=未跑；用户接受=未接受。
