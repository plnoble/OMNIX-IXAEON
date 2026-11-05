# 规格 MP3c：开发工具，编码任务一串替补，调度器面板拦住「自己审自己」（MP3c / MP3d / MP3e / MP3f）

档位：**B**。要起三个本机程序替用户改代码（新的执行器），存新的路径与选择；调度器面板会改调度器的持久配置。

**分四单，各自源码不超过 300 行**，依次做，后一单基于前一单：

| 单       | 做什么                                                                   | 约     |
| -------- | ------------------------------------------------------------------------ | ------ |
| **MP3c** | 找到 Claude Code / Codex / DSH 装在哪（可以手改），「模型」页显示        | 200 行 |
| **MP3d** | 编码任务的一串候选（配置、按顺序换、5 分钟先跳过）+ Claude Code 执行器   | 280 行 |
| **MP3e** | DSH 执行器 + 「模型」页「编码任务」改成主选 + 替补列表                   | 250 行 |
| **MP3f** | 驾驶舱调度器面板：审查、整合不能跟开发选成同一个模型；拿掉作废的两行替补 | 120 行 |

依赖：队列第 164 行（MP3 / MP3b）已并入。吸收第 87 行 D8（编码任务加 Claude Code）、第 135 行 XE1（编码执行器占位）。

来源：用户 2026-11-03（[三周任务单](../三周任务单.md)「模型池」一节）：

- 「Claude Code、Codex、DSH 算开发工具。IXAEON 自己找到它们装在哪（可以手动改），用途列表里可以选它们来干活：一项 = 开发工具 + 模型 / 组，或者 供应商 + 模型 / 组」；
- 「整合、审查的替补不能跟开发用同一个模型……找不到不同的就等着，不降级凑合」。

用户 2026-11-05 定：

- 开发、审查、整合三个角色的「不行换下一个」**留在驾驶舱调度器面板**，靠 magpie 分组换（MG2 已做），这一组不在模型页给它们排替补；面板只加一道拦。
- 编码任务**三个开发工具都接**（Codex、Claude Code、DSH）。

## 为什么

任务页派发的编码任务现在只能交给 Codex 或「我的模型」中的一个，Codex 额度用完这一单就失败，要用户自己去设置里换。用户想要的跟聊天一样：排好顺序，第一个不行换第二个，并写明是谁做的。另外调度器面板现在能把审查选成跟开发同一个模型，等于自己审自己。

## 要什么

### MP3c：找到三个开发工具

1. **找位置只写在一处**：`packages/core` 里 `detectDevTools(input: { manual: { codex?: string; claude?: string; dsh?: string }; env: NodeJS.ProcessEnv; exists?: (p: string) => boolean })`。它返回三行 `{ tool: 'codex' | 'claude' | 'dsh'; found: boolean; path: string | null; source: 'manual' | 'auto' | null; note: string | null }`，顺序固定为 codex、claude、dsh。只看文件在不在，**不运行它们**。
   - 手填了的那一项**只认手填的**：在就是 `manual`，不在就是没找到，`note` 写「手填的位置没有这个程序」，不再往下自动找。
   - 没手填就按下面的顺序找，第一个在的算数（`auto`）：
     - **Codex**：`IXAEON_CODEX_EXE`（值为 `none` 时视作没找到，`note` 写「已设成不用 Codex」）→ `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe`。跟现在 `resolveCodexLocator` 的顺序一样，`resolveCodexLocator` 改成调这里。
     - **Claude Code**：`IXAEON_CLAUDE_EXE` → `%USERPROFILE%\.local\bin\claude.exe` → `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`。
     - **DSH**：`IXAEON_DSH_INSTALL` → `D:/Agent/DeepSeek Harness/Install` → `%LOCALAPPDATA%\Programs\DeepSeek Harness`。跟 `packages/relay/bin/dsh.mjs` 的顺序一样。DSH 的 `path` 是**安装目录**，目录下要同时有 `DeepSeek Harness.exe` 和 `resources/app.asar` 才算找到（`app.asar` 是个文件，只探到这一层）。
   - 没找到时 `path` 为 `null`，`note` 写「没找到，可以手填位置」。
2. **手填的位置存在新的 `config.devTools`**：`{ codex?: string; claude?: string; dsh?: string }`，默认 `{}`，不用迁移。IPC：
   - `getDevTools(): Promise<DevToolView[]>`：就是第 1 条那三行；
   - `saveDevToolPath(input: { tool: 'codex' | 'claude' | 'dsh'; path: string | null })`：`null` 或空串表示删掉手填、回到自动找。手填的位置要是绝对路径，否则拒绝。**不在就不让存**，提示「这个位置没有 <工具名>」。审计只记工具名和「手填 / 恢复自动」，不记路径。
3. **Codex 执行器用这里找到的位置**：手填优先。派发时 Codex 没找到，提示照旧是「没找到 Codex」那一类，但多一句「可以在『模型』页的开发工具里手填位置」。
4. **「模型」页加「开发工具」一块**，放在「供应商」和「用途」之间。三行：工具名、找到 / 没找到、位置、是手填的还是自动找的。每行能填位置、保存、「恢复自动」。拒绝的提示原样显示。data-testid：`devtool-row-<tool>`、`devtool-path-<tool>`、`devtool-save-<tool>`、`devtool-auto-<tool>`。

### MP3d：编码任务一串候选 + Claude Code

5. **一项是什么**：`CodingChoice = { kind: 'tool'; tool: 'codex' | 'claude' | 'dsh'; model?: string } | { kind: 'provider'; providerId: string; model: string }`。
   - `provider` 这一种就是现在的「我的模型」执行器，换成用那一家那个模型。只能选勾选保存过的模型，magpie 分组在 magpie 那家的已保存模型里，也能选。
   - `tool` 的 `model`：
     - Claude Code 只能是 `opus`、`sonnet`、`haiku` 之一，或者不填（跟 Claude Code 自己的设置）；
     - Codex 和 DSH 这一单**不填**（跟它们自己的设置），填了就拒绝。
6. **存在新的 `config.codingChain`**：主选在前，最多 5 项，不能重复（同一种、同一个工具或同一家、同一个模型算重复）。IPC 是 `saveCodingChain(list: CodingChoice[])`，传空数组等于清空。
   - 没存过 `codingChain` 时，照旧从 `coding.executor` / `coding.modelName` 推出一项，现有设置和锁定测试的行为不变。存过就只看它。
   - 审计只记项数和每项的种类与工具名，不记模型名以外的东西。
7. **派发时按顺序换下一个**。规则只写在一处，包在 `ConfiguredCodingExecutor` 那一层：
   - 这一项的工具没找到，或者那家供应商解析不出来（没了、没 Key）→ 跳过，不算一次失败；
   - 跑了，但是失败了，并且原因属于下面三类 → 换下一个：
     - 额度：输出里有 `usage_limit_reached`、`rate_limit_exceeded`、`session limit` 之一（跟调度器 `quotaPatterns` 同一组，不加裸的 429）；
     - 供应商那一项：`ModelError` 的状态码是 401 / 403 / 402 / 429 / 5xx，或者没有状态码、`retriable` 为真（跟 MP3 同一判定，复用 `acceptableFallback`）；
     - **前提是这一次没有改动工作区**：用派发已有的工作区指纹比开工前后，有改动就不换，照失败回报，不把两个工具的半截改动叠在一起；
   - 用户取消、超时、别的失败 → 不换；
   - 换过的话，回报的 `summary` 以这一句开头：「<名字>这次不行（<原因>），由替补<名字>来做」。
     - 名字写法：「Codex」「Claude Code · sonnet」「DSH」「<供应商名> · <模型>」，外面加「」。
     - 原因只有四种：额度用完 / Key 不对或没权限 / 服务出错 / 连不上或超时。工具的额度一律写「额度用完」。
   - 都不行：失败回报写明试过哪几项、各自为什么不行；
   - 5 分钟内先跳过刚不行的那一项（排到最后，不删）：只记内存，键是「编码 + 种类 + 工具或供应商 + 模型」，保存编码候选、保存供应商、改开发工具位置时清空。跟 MP3 同一套写法。
8. **Claude Code 执行器**：`ClaudeCodeExecutor`，argv 写死，不拼 shell：
   - `[<claude.exe>, '-p', <任务交代>, '--output-format', 'json', '--permission-mode', <模式>]`，选了模型再加 `'--model', <模型>`；
   - `cwd` 是隔离工作区；
   - 模式：普通任务用 `acceptEdits`；只读范围（`readScope`）里的文件照现在 Codex 的办法写进交代，不靠权限模式；
   - **不加** `--dangerously-skip-permissions`、`--add-dir`、`--allowedTools`，不设任何权限相关的环境变量；
   - 交代就是现在给 Codex 的那段（`task.goal`），一字不改；
   - 结果从标准输出那一个 JSON 里取 `result` 当摘要；`is_error` 为真或退出码非 0 算失败；
   - 进程监督（超时、取消时杀进程树）复用 Codex 那一套；
   - 回报的执行器名字记 `claude-code`。

### MP3e：DSH 执行器 + 界面

9. **DSH 执行器**：`DshExecutor`。
   - 起法跟 `packages/relay/bin/dsh.mjs` 一样：`<安装目录>/DeepSeek Harness.exe`，环境里设 `ELECTRON_RUN_AS_NODE=1`，第一个参数是 `<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`。后面接 `['--profile', 'headless', '--json', <任务交代>]`，`cwd` 是隔离工作区。
   - **不加、不改**任何权限相关的参数和环境变量（照 `dsh.mjs` 的规矩）。调度器专用的那几个环境变量（`GIT_CONFIG_PARAMETERS`、`IXAEON_WORKTREES`、测试里关沙箱的那个）这里都不设。
   - 结果：标准输出里最后一行 `type` 为 `final` 的 JSON，取它的 `text` 当摘要；没有这一行或退出码非 0 算失败。
   - 进程监督复用 Codex 那一套；执行器名字记 `dsh`。
10. **「模型」页「用途」里的「编码任务」改成主选 + 替补**：一个列表，最多 5 项，有上移 / 下移 / 删掉 / 添加，跟 MP3b 的替补列表一个样子（按钮跟着各自那一项）。
    - 添加时先选种类：「开发工具」或「供应商」。开发工具三选一，Claude Code 再选模型（默认 / opus / sonnet / haiku）；供应商从已保存模型里选。
    - 没找到的开发工具也能选，项后面标「没找到」，派发时跳过（第 7 条）。
    - 保存跟「用途」共用「保存」按钮，存 `saveCodingChain`。拒绝提示原样显示。
    - data-testid：`coding-chain-list`、`coding-chain-add`。

### MP3f：调度器面板拦住「自己审自己」

11. **审查、整合不能跟开发选成同一个模型**。保存调度器面板的选择时（三个角色任一个改动），按下面比：
    - 开发的值是「网关 / 模型」，取 `/` 后面的模型名；
    - **审查**：审查的模型名（`codexModel`）跟开发的模型名一样（不分大小写）→ 拒绝；
    - **整合**：整合选了 `opus` / `sonnet` / `haiku`，开发的模型名里同时含 `claude` 和这个词（不分大小写）→ 拒绝；
    - 拒绝的提示写明哪两个角色撞了、撞的是哪个模型，比如「审查和开发都是 xxx，换一个（关卡不能自己审自己）」；
    - 两边有一边是「默认」或「跟 Codex 自己的设置」→ 不拦，没法知道实际是哪个；
    - 开发选的是 magpie 分组 → 不拦，那一行下面显示一句「分组里有哪些模型 IXAEON 不知道，留意别跟审查、整合重了」。
12. **拿掉作废的两行**：面板上不再显示「替补审查」「替补整合方」（用户 11-04 定代审、替补整合改成手动开 DSH）。调度器配置里有这两个角色也不删，只是不显示、不改。

## 约束

- 档位 B：测试先交整合方锁定，再写实现。
- 每单源码不超过 300 行；超了先拆，或者先在交付说明里说，不要交了再说「不到 300」。
- 不改已锁定的测试；不改 MP3 的聊天、后台分析替补；不改调度器程序（`packages/relay/src`）本身。
- 探测和执行的日志、报错、审计、交付说明里都**不写本机路径**：路径里有账户名。界面上给用户自己看可以。
- Claude Code 用的是用户 Claude Pro 的额度，跟整合方共用。不要在测试或真机检查里真跑 Claude Code、Codex、DSH，一律用假程序（见真机检查）。
- 不新增网络访问；三个工具自己连网是它们的事。

## 验收条件

MP3c：

1. 三个工具手填优先：手填的在就用手填的（`source: 'manual'`）；手填的不在就算没找到，不往下自动找。
2. 没手填时按第 1 条的顺序找，第一个在的算数；都不在时 `found: false`、`path: null`、`note` 是「没找到，可以手填位置」。Codex 的 `IXAEON_CODEX_EXE=none` 算没找到。
3. DSH 的安装目录下少 `DeepSeek Harness.exe` 或 `resources/app.asar` 任一个，就算没找到。
4. `saveDevToolPath`：
   - 相对路径拒绝；不在的位置拒绝，提示带工具名；
   - `null` 或空串删掉手填；
   - 审计里没有路径。
5. Codex 执行器用 `detectDevTools` 的结果，手填的位置优先。
6. 「模型」页有三行开发工具，显示找到 / 没找到、手填 / 自动。手填保存后这一行变成手填；「恢复自动」后变回自动。

MP3d：

7. `saveCodingChain` 拒绝：
   - 超过 5 项、有重复的；
   - 供应商那一项的模型没保存过的；
   - Codex / DSH 填了模型的；
   - Claude Code 的模型不在 opus / sonnet / haiku 里的。

   传空数组清空。没存过时，行为跟现在一样：`coding.executor` 为 `codex` 就交 Codex，为 `model` 就交那个模型。

8. 主选 Codex 跑完输出里有 `usage_limit_reached`、工作区没改 → 换第二项来做。回报以「「Codex」这次不行（额度用完），由替补「Claude Code · sonnet」来做」开头，执行器名字记实际做的那个。
9. 主选失败但工作区已经有改动 → 不换，照失败回报。用户取消、超时、别的失败也不换。
10. 主选的工具没找到 → 直接用第二项，不算失败，也不写那一句提示。
11. 5 分钟内先跳过：同一个主选刚因额度不行，3 分钟后再派发一单先用第二项；6 分钟后又先试主选。保存编码候选后马上先试主选。
12. Claude Code 执行器的 argv：
    - 正好是第 8 条写的那样，选了模型多 `--model`；
    - argv 里没有 `--dangerously-skip-permissions`、`--add-dir`、`--allowedTools`；
    - `cwd` 是隔离工作区；
    - 摘要取 JSON 的 `result`；`is_error` 为真算失败。

MP3e：

13. DSH 执行器的起法：
    - 程序、第一个参数、后面的参数正好是第 9 条写的那样；
    - 环境里有 `ELECTRON_RUN_AS_NODE=1`，没有 `GIT_CONFIG_PARAMETERS`（宿主本来就有的除外）、没有 `IXAEON_WORKTREES`；
    - 摘要取最后一行 `final` 的 `text`；没有这一行算失败。
14. 「模型」页的编码任务列表能加开发工具（含 Claude Code 选模型）和供应商两种。上移 / 下移 / 删掉真的改顺序，保存时 `saveCodingChain` 收到的就是新顺序。没找到的工具标「没找到」。
15. 端到端（`apps/desktop/e2e/mp3e-coding-chain.spec.ts`）：
    - 合成数据目录，两个假开发工具：假 Codex 输出 `usage_limit_reached` 后退出；假 Claude Code 在工作区写一个文件，输出 `{"result":"done","is_error":false}`；
    - 在「模型」页手填两个假工具的位置，编码任务排「Codex → Claude Code」，保存；
    - 在任务页派发一单，回报里看到那一句提示，改动是假 Claude Code 写的那个文件。

MP3f：

16. 开发是「某网关 / gpt-x」时，把审查选成 `gpt-x` 被拒，提示里有「审查」「开发」和 `gpt-x`。反过来，审查已是 `gpt-x` 时把开发选成「某网关 / gpt-x」也被拒。
17. 开发是「某网关 / claude-opus-x」时，整合选 `opus` 被拒、选 `sonnet` 可以。整合是「默认」、审查是「跟 Codex 自己的设置」时都不拦。开发选 magpie 分组时不拦，显示那句提醒。
18. 面板上没有「替补审查」「替补整合方」两行；调度器配置里原有的这两个角色原样保留。

## 真机检查

- **MP3c**：`scripts/real/mp3c-devtools.mjs` 只输出三行「工具名：找到 / 没找到、手填 / 自动」，不输出路径。在本机跑一次，贴输出。
- **MP3d / MP3e**：`scripts/real/mp3d-coding-chain.mjs` 用临时数据目录和**假程序**（一个只输出 `usage_limit_reached` 的假 Codex、一个写文件的假 Claude Code、一个输出 `final` 行的假 DSH，都在临时目录里现做）。分别跑「Codex → Claude Code」「Codex → DSH」两串，输出谁做的、换了几次、那一句提示。临时目录路径遮掉。**不跑真的 Claude Code / Codex / DSH。**
- **MP3e 界面**：设 `IXAEON_DATA_DIR=<临时目录>` 启动，在「模型」页看开发工具一块，排一串编码候选并截图。
- **MP3f**：设 `IXAEON_RELAY_DIR=<合成 relay 目录>`，合成 config 和合成补丁，不碰用户真实的 relay 目录与 DSH 配置。在面板上试一次撞模型被拒，截图，再贴出合成 config 前后的 diff（应当没有变）。

## 拆单与交付

- 四单分别是分支 `dev/MP3c`、`dev/MP3d`（基于 MP3c）、`dev/MP3e`（基于 MP3d）、`dev/MP3f`（基于 main，跟前三单没有共用文件，可以先做）。
- 测试：每单的验收条件写成 `<单号小写>-*.test.ts`，测试开头注释逐条对应。四单的测试可以一次交齐，再给整合方锁定。端到端的那份留在 `dev/MP3e` 上，跟实现一起并入。
- 交付说明 `docs/委派/交付/<单号>.md`，四者分开写：已实现 / 自动化通过 / 真机通过 / 用户接受。

## 测试入口（整合方 2026-11-05 补）

第一次交的测试没覆盖条件 5、8–13、16、17，理由是规格没写死入口。下面写死，照这些写测试。名字、参数就用这些，不另起。

- **条件 5**：`resolveCodexLocator(input?: { manual?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean })`。不传参数时行为跟现在一样，传了就交给 `detectDevTools`。测：手填的在 → `exe` 是手填的；手填的不在 → `null`。
- **条件 7 补两条**（第一次交的漏了）：
  - 合法的一串存进去，读 `getSettings` 或配置能原样读回；
  - 没存过 `codingChain` 时，`executorPlan()` 照旧：`coding.executor` 为 `codex` 交 Codex，为 `model` 交那个模型。
- **条件 8–11**：编码候选串的执行器在 core，`packages/core/src/execution/codingChain.ts`，从 `@ixaeon/core` 导出。
  - 构造：`new CodingChainExecutor(candidates: () => CodingCandidate[], opts: { skip: Map<string, number>; now?: () => number })`。
    - `CodingCandidate = { key: string; label: string; executor: CodingExecutor | null }`。`label` 就是提示里「」里那段，比如 `Codex`、`Claude Code · sonnet`。`executor` 为 `null` 表示没找到或解析不出，跳过。
    - `skip` 是「键 → 到期毫秒数」，由运行时持有、保存时清空。测试自己传一个 `Map` 和 `now`。
  - 判定：MP3 的 `acceptableFallback` / `reasonText` 从 `apps/desktop/src/main/modelFallback.ts` 挪到 `packages/core/src/models/fallbackRules.ts` 并导出，桌面那边改成引用它，行为不变。工具的额度看三个错误码：抛出的错误信息，或者回报的 `raw` / `summary` 里有就算。
  - 工作区改没改：每次试之前、之后各取一次 `hashWorkspace(workspace)` 比（不算 `EXECUTOR_CHANNEL_FILE`）。
  - `name`：`run` 之前是第一个可用候选的执行器名字；`run` 结束后是实际做完（或最后一个试过）的那个。编排层在 `run` 之后再写一次执行器名字。
  - 测试用假的 `CodingExecutor` 对象（不起进程），在工作区里写不写文件由假对象自己决定。
- **条件 12、13**：起进程的参数和读结果写成纯函数，都在 core 导出。执行器只是把它们接上进程监督。
  - `claudeCodeLaunch(input: { exe: string; goal: string; workspace: string; model?: 'opus' | 'sonnet' | 'haiku' }): { command: string; args: string[]; cwd: string }`；
  - `parseClaudeCodeOutput(stdout: string, exitCode: number | null): { ok: boolean; summary: string }`；
  - `dshLaunch(input: { install: string; goal: string; workspace: string; baseEnv: NodeJS.ProcessEnv }): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }`。`env` = `baseEnv` 加 `ELECTRON_RUN_AS_NODE=1`，不加别的；
  - `parseDshOutput(stdout: string, exitCode: number | null): { ok: boolean; summary: string }`；
  - 执行器：`new ClaudeCodeExecutor({ exe, model? })`（`name` 为 `claude-code`）、`new DshExecutor({ install })`（`name` 为 `dsh`）。子进程环境跟 Codex 执行器用同一个最小环境，DSH 再经 `dshLaunch` 加那一项。
  - 测纯函数即可：argv 逐项相等；没有那三个开关；`parseClaudeCodeOutput('{"result":"done","is_error":true}', 0).ok === false`；DSH 输出有好几行 JSON 时取最后一行 `final`。
- **条件 16、17**：用已有的 `setRelayModel(opts, input)`（K10a / MG2），拒绝时抛 `VALIDATION_FAILED`。测试用合成 relay 目录。
  - 比较时值里有「网关 / 」前缀的去掉前缀再比。现在整合、审查也能选 magpie 的模型（MG2），一样比。
  - 任一边是分组（`group/` 开头）→ 不拦。开发那一行的提醒写在 `readRelayModels` 返回的开发那一行 `note` 里。
  - 被拒时 config 和补丁文件一个字节不变（K10a 的 `.bak` 也不留）。
- **端到端里的假程序**：执行器不经 shell 起进程，`.cmd` 起不来，所以假程序要是真的 `.exe`。
  - 做法：在测试的辅助文件里用 Windows 自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（CI 的 windows-latest 也有）现编一个小启动器。它读同目录 `<名字>.fake.json` 里写好的行为（往标准输出打什么、往工作区写什么文件、退出码几），把收到的参数和 `cwd` 记到一个文件里，然后退出。
  - 编好的放临时目录，同一次测试只编一次。辅助文件放 `apps/desktop/test/helpers/` 或 `apps/desktop/e2e/helpers/`，不算源码行数。
  - 找不到 `csc.exe` 时端到端失败并写明原因，不跳过。
