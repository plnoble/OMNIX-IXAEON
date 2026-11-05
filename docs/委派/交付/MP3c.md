# MP3c / MP3d / MP3e / MP3f 测试交付（B 档，先只推测试）

规格：[MP3c-开发工具与编码替补.md](../MP3c-开发工具与编码替补.md)，验收条件 1–18。四单的测试都在这一个分支 `dev/MP3c` 上一起交；实现还没写，**现在应当红**。

## 写了哪些测试、对应哪几条

| 文件                                                        | 对应条件                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/acceptance/mp3c-devtools.test.ts`       | MP3c 条件 1、2、3：`detectDevTools` 手填优先/自动顺序/DSH 要 exe 与 app.asar 同时存在                                                                                                                                                           |
| `apps/desktop/test/acceptance/mp3c-devtool-save.test.ts`    | MP3c 条件 4：`saveDevToolPath` 相对路径拒绝、不在的位置拒绝且提示带工具名、null/空串删手填、审计里没有路径                                                                                                                                      |
| `apps/desktop/test/acceptance/mp3c-devtools-ui.test.ts`     | MP3c 条件 6：「模型」页三行开发工具（`devtool-row/path/save/auto-<tool>`），找到/没找到、手填/自动，手填后变手填、恢复自动变回                                                                                                                  |
| `apps/desktop/test/acceptance/mp3d-coding-chain.test.ts`    | MP3d 条件 7：`saveCodingChain` 的拒绝（>5、重复、供应商模型没保存过、Codex/DSH 填模型、Claude 模型不在 opus/sonnet/haiku）、空数组清空                                                                                                          |
| `apps/desktop/test/acceptance/mp3e-coding-chain-ui.test.ts` | MP3e 条件 14：编码任务的主选+替补列表（`coding-chain-list`/`coding-chain-add`），加开发工具与供应商、上移/下移/删掉改顺序、保存时 `saveCodingChain` 收到新顺序、没找到的工具标「没找到」                                                        |
| `apps/desktop/test/acceptance/mp3f-panel.test.ts`           | MP3f 条件 18：面板不再显示「替补审查」「替补整合方」两行                                                                                                                                                                                        |
| `apps/desktop/e2e/mp3e-coding-chain.spec.ts`                | MP3e 条件 15（端到端）：假 Codex 输出 `usage_limit_reached`、假 Claude Code 写文件并输出 JSON；模型页手填两个假工具、编码任务排「Codex → Claude Code」，任务页派发，回报写「「Codex」这次不行（额度用完），由替补「Claude Code · sonnet」来做」 |

假程序一律在临时目录里现做（假的 `.cmd` 脚本），不跑真的 Codex / Claude Code / DSH；测试和日志里没有本机路径与账户名。

锁定：`lock MP3c`（3 份）、`lock MP3d`（1 份）、`lock MP3e`（1 份）、`lock MP3f`（1 份）已登记。

## 现在红在哪

`vitest --project acceptance`（6 份）：**22 failed | 0 passed**，红的原因都是「功能没有」：

- `mp3c-devtools` 8 红：`detectDevTools` 不存在（运行时取到 undefined）；
- `mp3c-devtool-save` 3 红：`saveDevToolPath` 不存在（抛 `NOT_IMPLEMENTED` 标记；拒绝类用例先排除该标记，避免拿「方法不存在」冒充拒绝）；
- `mp3c-devtools-ui` 2 红：找不到 `devtool-row-codex`；
- `mp3d-coding-chain` 6 红：`saveCodingChain` 不存在；
- `mp3e-coding-chain-ui` 2 红：找不到 `coding-chain-list`；
- `mp3f-panel` 1 红：面板仍显示「替补审查 / 替补整合方」。

端到端 `mp3e-coding-chain.spec.ts` 现在也红（开发工具块、编码任务列表都还没做）。

## 写不成测试 / 有问题（请整合方定）

1. **MP3c 条件 5**（Codex 执行器用 `detectDevTools` 的结果、手填优先）：Codex 执行器怎么取路径是内部实现，规格没写死可单测的函数/构造；写成「派发时报错文案含手填提示」也能测，但需要先有派发夹具，且文案细节容易与实现耦合。没写，列在这里。
2. **MP3d 条件 8–11**（派发时按顺序换下一个、工作区指纹、5 分钟记忆）：规则落在 `ConfiguredCodingExecutor` 那一层，但候选串的 `ExecutorPlan` 新形状、工作区指纹与「按需求 run」的入口规格没写死。硬写只能自己发明接口，按要求没做。
3. **MP3d 条件 12 / MP3e 条件 13**（`ClaudeCodeExecutor` / `DshExecutor` 的 argv、环境、输出解析）：类名规格写了，但所在模块、构造参数、如何注入假程序都没写死；我按「用假 `.cmd` + 端到端」覆盖了「能起来」的一半（条件 15），单测的 argv 断言没有写，避免发明构造函数。
4. **MP3f 条件 16、17**（审查/整合不能跟开发同一个模型的拒绝规则）：落在主进程保存链上，规格没给可单独调用的函数名；`setRelayModel` 的拒绝由主进程做，测试只能验证界面把拒绝原样显示，验证不到规则本身。没写，列在这里。
5. **端到端条件 15 的假工具可执行性**：Windows 上假程序是 `.cmd`，如果执行器用 `spawn` 不带 shell 会启不起来；实现时若要求「真 .exe」，端到端的假程序要改成「复制 node.exe + JS 脚本」的方式，届时同步这一份测试即可（断言不变）。

## 四项

- 已实现：无（本单只写测试）。
- 自动化通过：无（现在应当红）。
- 真机通过：未跑（实现还没有）。
- 用户接受：未接受。
  ﻿

## 补测（整合方 11-05 退回，按「测试入口」一节）

按规格末尾「测试入口（整合方 2026-11-05 补）」补齐条件 5、7 补两条、8–13、16、17，名字与参数就用那一节写死的。

| 文件                                                               | 对应条件                                                                                | 现在红在哪                                                                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/test/acceptance/mp3c-codex-locator.test.ts`          | 5（`resolveCodexLocator(input?)`）                                                      | 传参数后仍走旧逻辑/不接受参数，手填的在也没用上（红在「不是函数」或结果不对）                                       |
| `apps/desktop/test/acceptance/mp3d-coding-chain.test.ts`（补两条） | 7 补：合法串原样读回；没存过 `codingChain` 时 `executorPlan()` 照旧                     | `saveCodingChain` 不存在                                                                                            |
| `packages/core/test/acceptance/mp3d-chain-executor.test.ts`        | 8–11（`CodingChainExecutor` + 假 CodingExecutor）                                       | `CodingChainExecutor` 没导出（「不是构造函数」）                                                                    |
| `packages/core/test/acceptance/mp3d-launch-pure.test.ts`           | 12、13（`claudeCodeLaunch` / `parseClaudeCodeOutput` / `dshLaunch` / `parseDshOutput`） | 四个纯函数都没导出                                                                                                  |
| `apps/desktop/test/acceptance/mp3f-rules.test.ts`                  | 16、17（`setRelayModel` 拦「自己审自己」）                                              | 该拒的没拒（现在都能存）                                                                                            |
| `apps/desktop/e2e/mp3e-coding-chain.spec.ts`（改假程序）           | 15                                                                                      | 假程序改成 csc 现编的 `.exe`（`apps/desktop/e2e/helpers/fake-tool.ts`），端到端仍红（开发工具块、编码候选列表未做） |

合计：`vitest --project acceptance` 10 份 → **44 failed | 0 passed**，红因都是「功能没有」（`detectDevTools`/`saveDevToolPath`/`saveCodingChain`/`CodingChainExecutor`/四个纯函数不存在、两处界面找不到、面板仍显示作废两行、relay 没拦）。已按新文件重锁：MP3c 4 份、MP3d 3 份、MP3e 1 份、MP3f 2 份。

原先「写不成测试」的 5 条现在都有入口了：条件 5、8–13、16、17 已按整合方给的名字写成测试；端到端假程序按 csc 现编 `.exe` 的做法改了（辅助文件在 `apps/desktop/e2e/helpers/fake-tool.ts`）。

## 整合方锁定（2026-11-05）

锁之前用一次性原型（不提交）试过：找位置、编码候选串、四个纯函数三份 28 条，正确的实现能全过。故意改坏七处都能抓到：不看工作区改没改、不记 5 分钟、取消了也换、DSH 多带一个环境变量、手填不在就往下找、Claude 多带放开权限的开关、400 也换。调度器面板的拦截也原型试过，除了「分组提醒」那句没写，其余都过。界面两份、端到端没用原型试。

改了的地方：

- **编码候选串**：
  - 原来写成 `new chainCtor()(…)`，正确的实现也会报「类不能不用 new 调」，12 条全红，已改；
  - 「都不行」那条把抛出的错误 `JSON.stringify` 成了 `{}`，改成读错误信息，并要求写出「额度用完」；
  - 补了几条：额度写在失败回报 `raw` 里也换；供应商 401 换、400 不换；已经取消时就算有额度错误码也不换；成功时回报原样；`run` 之前 `name` 是第一个可用的；
  - 「工作区有改动不换」那条原来不接住抛出的错误，正确的实现照失败抛出时测试会挂，已改。
- **纯函数**：DSH 的环境变量要求正好只多一项、不改传进来的 `baseEnv`；好几行 `final` 取最后一行；退出码非 0、不是 JSON 都算失败。
- **找位置**：补了「几个候选都在时前面的赢」（三个工具各自的顺序，含环境变量优先）；路径比较不分 `\` 与 `/`。
- **保存位置**：补了「真的存进 `config.devTools`、null 和空串真的删掉」。
- **没存过编码候选时照旧**：原来用第二家供应商的模型，旧逻辑只认第一家，**在现在没改过的代码上就红**。改成用第一家（`saveModelSettings`），现在的代码上已经通过。
- **调度器面板**：
  - 原来合成补丁没有 `agent-default-model` 段、config 没有整合方那一行，所有「被拒」其实都是「读不懂配置」；
  - **也没把 `DSH_HOME` 指到临时目录，会去读本机真实的 DSH 桌面版配置**。三处都改了；
  - 被拒的提示要写出撞的是哪两个角色；分组照 MG2 的写法（magpie 清单 + `magpie / group/…`）；补了整合方选 magpie 的模型（id 里带斜杠）撞了也拦。
  - 改完之后在现在的代码上：「默认不拦」那条通过，其余红在「没拦」，红得对。
- **编码任务界面**：原来只点「添加」用默认选中的那一项，没选种类、工具、模型，也没核对保存的内容。按规格新写死的四个下拉重写：加三种、核对保存的是 `{ kind, tool, model }` 原样、上移 / 下移 / 删掉逐步核对顺序、选「默认」不带 `model`、满 5 项「添加」不能点。
- **端到端**：
  - 假程序原来用 `System.Text.Json` 和 `using var`，Windows 自带的 csc（C# 5）编不过，已在本机证实。改成逐行的行为文件，本机编过、跑过（输出、写文件、退出码、中文参数都对）；
  - 假 Codex 原来退出 0，那是成功，正确的实现不该换，改成退出 1；
  - 添加改成按下拉选。
