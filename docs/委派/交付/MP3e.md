# MP3e 交付说明：DSH 执行器 + 编码任务主选/替补 + 端到端

分支 `dev/MP3e`，基于 `dev/MP3db`。

## 已实现

- `DshExecutor`（`packages/core/src/execution/toolLaunch.ts`，`name: 'dsh'`，经 `dshLaunch` 起桌面版、取最后一行 `final`）。
- 「模型」页「编码任务」主选 + 替补列表：`coding-chain-list`、`coding-chain-add` 与四个下拉（`coding-chain-kind` / `coding-chain-tool` / `coding-chain-claude-model` / `coding-chain-provider`），选项文字与「没找到」标记照规格；上移 / 下移 / 删掉；保存时 `saveCodingChain` 收到新顺序；满 5 项「添加」禁用。
- 任务卡：执行报告里的 `summary` 以「这次不行（」起头时，把那句「「甲」这次不行（原因），由替补「乙」来做」原样显示（从已有的 `executor_report_json` 取，不加新字段、不改 contracts）。

## 这轮查到的三个真 bug（端到端一直红就是它们）

1. **`getSettings().config` 没暴露 `codingChain`** → 界面读不回、端到端读不到（`CHAIN undefined`）；已补进契约与主进程。
2. **`saveUses` 顺序不对**：先存 uses，因向导建的模型没「勾选保存过」抛 `IXA0012`，后面替补和编码候选永远不跑；改成**先存编码候选**，再存 uses / 替补，出错照原样显示。
3. **`ClaudeCodeExecutor` / `DshExecutor` 回报缺 `changedPaths`**，编排层 `report.changedPaths.map` 直接崩（`Cannot read properties of undefined (reading 'map')`）；已补 `changedPaths: []`、`testsModified: false`。

## 自动化通过

```
$ node scripts/acceptance.mjs run MP3e
```

`mp3e-coding-chain-ui.test.ts` 4/4；`tsc` 0；`node scripts/build.mjs` 通过。

```
$ node scripts/test-e2e.mjs desktop
25 passed (1.4m)
✓ desktop e2e 完成（81.7s）
```

（条件 15 已绿：假 Codex 报额度 → 换到假 Claude 写 `note.txt`，卡片上出现整句提示，执行器 `claude-code`、改了 1 个文件。）

## 真机通过

**「Codex → DSH」一串**（`node scripts/real/run-batch.mjs scripts/real/mp3e-coding-chain.ts`，假程序 csc 现编，不跑真的工具）：

```
谁做的： dsh
换了几次： 1
那一句提示： 「Codex」这次不行（额度用完），由替补「DSH」来做；DSH <假 exe 控制台中文乱码>
```

（最后一个字串是假 exe 控制台编码问题，链路与提示句本身正确；临时目录已整段遮成 `<临时目录>`。）

**界面真机检查**（`node scripts/real/mp3e-models-ui.mjs`，临时数据目录）：

```
编码候选列表： ["Codex","Claude Code · sonnet","DSH"]
截图: .logs/mp3e-models.png
```

四项：已实现=DSH 执行器、编码任务界面、任务卡提示句、三个 bug；自动化通过=UI 4/4、e2e 25/25；真机通过=上面两段；用户接受=未接受。
