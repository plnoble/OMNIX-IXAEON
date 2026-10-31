# CF1 聊天做首页、驾驶舱放第二 交付

- 分支：`dev/CF1`，基于 main `a8385a4`；档位 A
- 执行方：dev

## 已实现

- 应用启动后的默认页从驾驶舱改成聊天页：`App.tsx` 里 `useState<Page>('cockpit')` → `'ask'`。
- 导航第一项改成聊天：按钮仍是原来的聊天按钮（`data-testid="nav-ask"`，点击行为不变），显示名
  「问答」→「聊天」，整块挪到导航最前面；驾驶舱按钮原样挪到第二项。其余各项一个字没动、先后
  不变（总览、理解、待讨论、待办、目标、历史、项目、来源、检索、研究、任务、设置）。
- 驾驶舱页、聊天页、路由表都没改；只动了 `App.tsx` 的默认页那行和导航里两块按钮的位置/文字。

改动文件与行数（`git diff --stat origin/main...HEAD` 原样贴；交付说明本身不在这一笔里）：

```
 apps/desktop/src/renderer/src/App.tsx              |  27 ++--
 .../test/acceptance/cf1-chat-first-nav.test.ts     | 170 +++++++++++++++++++++
 .../交付/附件/cf1-first-screen.png                 | Bin 0 -> 110154 bytes
 docs/委派/锁定验收.json                            |   8 +
 scripts/real/cf1-chat-first.mjs                    | 165 ++++++++++++++++++++
 5 files changed, 357 insertions(+), 13 deletions(-)
```

源码改动 27 行（`apps/desktop/src/renderer/src/App.tsx`：+14/−13，其中一块是原样挪动的导航按钮），
在 300 行以内；验收测试、真机脚本、截图、锁定清单、交付说明不计入。

`nav-ask` 这个 `data-testid` 没有改名（只改显示文字）。仓库里 `scripts/real/a4-follow-live.mjs`、
`a5-model-failure-real.mjs`、`u4-open-task-from-report.mjs` 都按 `nav-ask` 找聊天入口，改 id 会
连带改这些；规格也只要求显示名改成「聊天」。

## 验收测试（v2 规格任务）

`apps/desktop/test/acceptance/cf1-chat-first-nav.test.ts`（3 条，已 `acceptance.mjs lock CF1`）：

- 条件 1：`createElement(App)` 初始渲染后 `page-ask` 在、`page-cockpit` 不在（启动默认页是聊天）。
- 条件 2：导航第一项文字正好是「聊天」，点它从驾驶舱回到 `page-ask`；第二项正好是「驾驶舱」，
  点它打开 `page-cockpit`。
- 条件 3：把改之前的导航顺序写死（`BEFORE = [驾驶舱, 总览, 理解, 待讨论, 问答, 待办, 目标, 历史,
  项目, 来源, 检索, 研究, 任务, 设置]`），断言实际导航等于 `[聊天, 驾驶舱, 总览, 理解, 待讨论,
  待办, 目标, 历史, 项目, 来源, 检索, 研究, 任务, 设置]`，即其余各项相对次序一个不动。

## 自动化通过

- `node scripts/acceptance.mjs run CF1`：通过，3/3。
- `node scripts/verify.mjs`：**没过**，卡在 `acceptance（已完成任务的锁定验收测试）`，正是规格预告
  的 K3 锁定测试撞红；它前面的步骤全过：
  - lint、format:check、local-user、typecheck、typecheck-acceptance：通过；
  - build（desktop / mcp / extension）：通过；
  - unit：69/69 通过；
  - integration：483 通过、17 跳过（500）；
  - acceptance-lock：91 个任务的 178 个锁定验收测试都没被改；
  - acceptance：1287 通过、**1 失败**（只有 K3 条件 6），失败原文见下一节；
  - 后面的 review 系列没跑到（verify 在这一步就退了）。本单只改了 `App.tsx`，仓库里渲染 `App`
    的测试只有 4 个：CF1、K3、N1、U4；N1 和 U4 单独跑过，15/15 通过。
- GitHub 上的 verify：**没看**（这一棒的推送由调度器替我做，见最后一行之前的 `RELAY-PUSH`）；
  分支 CI 会在 acceptance 这一步红，原因同上，等整合方改 K3 条件 6 后再看。

## 真机通过

- 脚本：`scripts/real/cf1-chat-first.mjs`（`node scripts/real/run-batch.mjs scripts/real/cf1-chat-first.mjs`）。
  临时数据目录 + 合成设置向导跑完关闭，再重新启动截第一屏；只写合成数据，输出遮掉本机临时目录。
- 输出原样：

```
===== scripts/real/cf1-chat-first.mjs =====
[runner] 数据目录核对：起应用=是，IXAEON_DATA_DIR=有
NAV ["聊天","驾驶舱","总览","理解","待讨论","待办","目标","历史","项目","来源","检索","研究","任务","设置"]
FIRST_SCREEN page-ask true
CLICK_COCKPIT page-cockpit true
CLICK_CHAT page-ask true
shots true
RESULT 通过：第一屏是聊天页、导航第一项「聊天」、第二项「驾驶舱」，两项都能点开；截图已落盘
[runner] cf1-chat-first.mjs 退出码=0｜RESULT 通过：第一屏是聊天页、导航第一项「聊天」、第二项「驾驶舱」，两项都能点开；截图已落盘

===== 汇总 =====
0	scripts/real/cf1-chat-first.mjs	RESULT 通过：第一屏是聊天页、导航第一项「聊天」、第二项「驾驶舱」，两项都能点开；截图已落盘

共 1 个，非 0 的 0 个
```

- 第一屏截图（真 Electron，2614×1582）：`docs/委派/交付/附件/cf1-first-screen.png`。看过：
  第一屏是聊天页（「新对话」和输入框），导航第一项「聊天」高亮、第二项「驾驶舱」，其余顺序如上。
- 没有用用户真实数据；截图里没有本机账户名或临时目录。

## Codex 审查（A 档）

**没跑。** 规格写死了这一单的停点：实现做完、自己的 CF1 测试都过之后，在交付说明里列出撞红的
K3 锁定测试，状态改「待复审（整合方）」，由整合方改 K3 那条并合并。撞红的锁定测试只有整合方能改，
本支在它改之前合不了，所以没有走 Codex 审查，也没有合并。

## 已知缺口

1. **撞红的锁定测试（按规格列出，没有改）**：
   - 文件：`apps/desktop/test/acceptance/k3-cockpit-page.test.ts`
   - 用例：`条件 6：导航第一项与默认页` › `导航第一项是「驾驶舱」，启动后默认打开驾驶舱，总览还在导航里`
   - 失败原文：`AssertionError: expected null not to be null`，在
     `apps/desktop/test/acceptance/k3-cockpit-page.test.ts:282`（`expect($('page-cockpit')).not.toBeNull()`）。
     这条写死了「默认页是驾驶舱、导航第一项是驾驶舱」，与 CF1 的要求正好相反；规格说由整合方改。
2. **其它按「默认页是驾驶舱」找元素的真机脚本（不是锁定测试、不是 e2e，没改）**：
   - `scripts/real/k3-cockpit-page.mjs`：重新启动后直接 `getByTestId('page-cockpit').waitFor(...)`，
     CF1 之后要先点 `nav-cockpit`；
   - `scripts/real/k4-cockpit-quota.mjs`：同样在启动后直接等 `page-cockpit`。
   这两个脚本是 K3/K4 的真机证据脚本，规格只许改 `App.tsx` 和导航相关行，所以留着，等整合方或
   后续单子补一次「先点驾驶舱」再跑。
3. 分支 CI 会在 acceptance 这一步红（只有 K3 条件 6），等整合方改完并合并后应转绿；本棒没推、
   没看 GitHub 运行号。
4. 规格里明说不在这一单做的：聊天页顶部「调度器在转 / 有 N 件等你处理」没有加。

## 用户接受

未发生（用户用过并认可之后才写）。