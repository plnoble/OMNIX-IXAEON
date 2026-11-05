# MP3e 交付说明（未完成）

分支 `dev/MP3e`，基于 `dev/MP3db`。

## 已实现

- `packages/core/src/execution/toolLaunch.ts`：新增 `DshExecutor`（`name: 'dsh'`，经 `dshLaunch` 起桌面版、取最后一行 `final`）。
- `apps/desktop/src/renderer/src/pages/Models.tsx`：「编码任务」主选 + 替补列表——`coding-chain-list`、`coding-chain-add` 四个下拉（`coding-chain-kind` / `coding-chain-tool` / `coding-chain-claude-model` / `coding-chain-provider`），按规格的选项文字与「没找到」标记；上移/下移/删掉改顺序；保存时 `saveCodingChain` 收到新顺序；满 5 项「添加」禁用。

## 自动化

- `apps/desktop/test/acceptance/mp3e-coding-chain-ui.test.ts`：**4/4 过**（`node node_modules/vitest/... mp3e-coding-chain-ui`）。
- `node scripts/build.mjs` 通过。
- `node scripts/test-e2e.mjs desktop`：**24 passed / 1 failed**，红的正是 `e2e/mp3e-coding-chain.spec.ts`（条件 15）。回报里执行器显示 `fake`，说明派发时没走 `codingChain`（像 `config.codingChain` 在派发时是空的 / 存进去没生效）。还没定位完。

## 真机通过

**没跑**：界面截图、以及「Codex → DSH」假程序那一串都没做。

## 停下来的一处

端到端里 `codingChain` 存了但派发仍用 Fake 执行器（`执行器 fake`）。下一步要在端到端里打印 `getSettings().config.codingChain`、确认 `saveCodingChain` 是否真的落盘、以及 `executorPlan()` 读到的时机（可能是保存后 `runtime.config` 没热更新，或 UI 保存时 chain state 还未提交）。在它转绿之前 MP3e 不能交审。

四项：已实现=DSH 执行器 + 编码任务界面；自动化通过=UI 4/4、e2e 24/25；真机通过=没跑；用户接受=未接受。
