# 规格 S3b：编码代理会话的选择导入——界面

档位：**A**（只接 S3a 已经复审过的 IPC，不碰隐私边界）。大小：中（≤250 行）。依赖：S3a。
v2 规格：你先把验收条件写成测试（`apps/desktop/test/acceptance/s3b-*.test.ts`，jsdom，照 `t3-todos-page.test.ts` 的搭法），测试和实现一起交，Codex 审查时核对测试有没有漏掉条件。

## 要什么

资料页（`Sources.tsx`）「导入文件夹」旁边加一个「导入编码代理会话」。点了 → 选文件夹 → 弹出会话清单 → 勾选 → 看一眼预计要分析多少字 → 导入。

## 契约

1. 按钮 `sources-import-agent-sessions`「导入编码代理会话」：`api.pickFiles('directory')` → `api.listAgentSessions({ ticket })`。
2. 清单（`agent-sessions-list`）：每行 `agent-session-<编号>`，有勾选框 `agent-session-check-<编号>`；显示工具（「Claude Code」/「Codex」）、标题、项目名（没匹配到写「未归属项目」）、修改时间、大小（KB/MB）、状态（「新」「已导入」「有更新」）。最新的在前。清单底下一行灰字：「另有 N 个 Codex 子代理会话、M 个认不出的文件没列出」（都是 0 就不显示）。
3. **默认一个都不勾。** 「全选有更新的和新的」按钮 `agent-sessions-select-new`。
4. 勾选变化后调 `api.estimateAgentSessions`，显示 `agent-sessions-estimate`：「将发给模型分析：约 X 万字（你说的 Y 万、AI 回答 Z 万）」。估算进行中显示「正在估算…」；一个都没勾不显示。
5. 导入按钮 `agent-sessions-import`「导入选中的 N 个」；N 为 0 时不能点。点了 → `api.importAgentSessions` → 显示结果：新导入几个、没变化几个、失败的逐个列原因；然后刷新资料列表。
6. 出错用 `ErrorBanner`；清单可以关掉（`agent-sessions-close`）。

## 约束

- 只用 S3a 的三个 IPC，渲染层不接触路径。
- 样式用现有的类（`item-row`、`badge`、`btn`、`field-row` 等），不另起一套。

## 验收条件

1. 点按钮后按顺序调了 `pickFiles('directory')` 和 `listAgentSessions`；取消选择时什么都不调。
2. 清单每行的工具、标题、项目、状态显示对；子代理和认不出的个数那行按规则显示或不显示。
3. 默认不勾；导入按钮不能点；「全选有更新的和新的」只勾这两种状态的。
4. 勾选后显示估算（数字格式按「约 X 万字」）；全部取消后估算消失。
5. 导入调用带的是清单号和勾选的编号；结果显示三类计数，失败的列出原因。

## 真机检查

用临时数据目录启动应用（`IXAEON_DATA_DIR`），对**合成的**会话文件夹走一遍：清单、勾选、估算、导入、资料页里出现新来源。截图或描述。**不要选用户真实的会话文件夹。**
