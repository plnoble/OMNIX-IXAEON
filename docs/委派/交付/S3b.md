# S3b 编码代理会话选择导入（界面） 交付

- 分支：grok/S3b，基于 main `3e2d64e`；档位 A
- 执行方：Grok

## 已实现

资料页「导入文件夹」旁新增「导入编码代理会话」：选文件夹 → 弹出会话清单（每行：工具、标题、项目、修改时间、大小、状态；最新的在前）→ 勾选 → 估算（「将发给模型分析：约 X 万字…」，进行中显示「正在估算…」）→ 导入（结果：新导入/没变化/失败三类计数，失败逐条列原因）→ 刷新资料列表。只用 S3a 的三个 IPC，渲染层不接触路径；默认一个都不勾，「全选有更新的和新的」只勾这两种。样式用现有类（`item-row`、`badge`、`field-row`、`btn`）。出错走 `ErrorBanner`，清单可关掉。

源码 199 行（只算 `apps/*/src`，验收测试、真机脚本、交付说明另计）：

```
 apps/desktop/src/renderer/src/pages/Sources.tsx | 199 ++++++++++++++
```

## 验收测试（先写后锁，`acceptance.mjs lock S3b`）

`apps/desktop/test/acceptance/s3b-agent-sessions-page.test.ts`（jsdom，照 t3-todos-page 搭法），5 条逐条对应规格：

1. 点按钮按顺序调 `pickFiles('directory')`、`listAgentSessions`；取消选择时什么都不调。
2. 每行工具/标题/项目（未归属写「未归属项目」）/状态显示对，最新的在前（后端按路径序返回、界面负责按修改时间倒排）；子代理与认不出的个数那行按规则显示或不显示。
3. 默认一个都不勾、导入按钮不能点；「全选有更新的和新的」只勾「新」「有更新」。
4. 勾选后显示估算（「约 X 万字」格式），进行中「正在估算…」；全部取消后消失。
5. 导入调用带清单号和勾选的编号；结果显示三类计数与失败原因；然后刷新资料列表。

## 自动化通过

- `node scripts/acceptance.mjs run S3b`：5/5 通过。
- `node scripts/verify.mjs`：全部通过（IXAEON v0.2 验证完成）。第一次跑时本机有正在使用的 IXAEON 实例占着固定端口 43191（单实例锁），`review-needs-lifecycle-ui` 一步被「不要动现有服务」守卫挡下；实例关掉后重跑全绿。中途 `review-recheck-ui` 的 BUI02 重启检查偶发过一次没等到主窗口，单独重跑该套件 3/3 过，完整 verify 再跑也全绿（判断为 `app.close()` 后单实例锁释放的竞态，与本单改动无关——本单只改渲染层）。
- GitHub 上的 verify：绿（运行 [35480869761](https://github.com/plnoble/OMNIX-IXAEON/actions/runs/35480869761)，2026-09-20）。

## 真机通过

`node_modules/.bin/jiti scripts/real/s3b-agent-sessions-ui.ts`（临时 `IXAEON_DATA_DIR` + 合成会话文件夹；文件夹选择走主进程 `IXAEON_TEST_DIALOG_RESPONSES` 测试钩子，只在环境变量存在时生效）。输出（行内各列连在一起是 textContent 的取法，界面上是分列的）：

```
LIST
Claude CodeS3b 合成任务：把会话选择导入做好未归属项目2026-09-20 01:240.5 KB新
ESTIMATE
将发给模型分析：约 0 万字（你说的 0 万、AI 回答 0 万）
RESULT
新导入 1 个、没变化 0 个、失败 0 个
SOURCE_ROW 1
	S3b 合成任务：把会话选择导入做好	未归属	对话	已收到，等待分析归档	2	0	2026-09-20 01:24:14
```

清单（工具/标题/项目/时间/大小/状态「新」）→ 全选 → 估算（合成会话只有 25 个字，四舍五入 0 万字，格式对）→ 导入（新导入 1 个）→ 资料列表出现新来源（类型「对话」、等待分析）。截图在本机 `apps/desktop/release/screenshots/s3b-agent-list.png` 与 `s3b-after-import.png`，未提交。

## Codex 审查（A 档）

待跑（分支推送后），结论写进 `S3b-Codex审查.md`。

## 已知缺口

- 估算按勾选变化整组重发，没有增量；快速连点会以后到的响应为准之外没有额外防抖（规格未要求）。
- 会话行的项目列只显示会话自己匹配到的项目，不随资料页的项目筛选变（规格只说显示项目名）。

## 用户接受

未发生。
