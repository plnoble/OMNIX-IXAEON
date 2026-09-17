# IXAEON v0.2.9 / M0–M1 独立复审

日期：2026-09-16。代码基线：`f71da15`。上轮基线：`bbe651f`。审核开始时工作区干净。

## 1. 结论：部分修复通过，M0/M1 不能按全部完成验收

这次不是完全没进展：旧反例 14/14 通过，TinyFish 的旧协议形状问题、已知自动来源迁移、暂停后的新渲染调用及 watchdog 调用清理等，都有对应改动。

但 **“Q01–Q07 全部清零”和“M1 阶段全部要求完成”超过了代码与证据能支持的范围**。本轮换一组输入后，仍可让未实际执行的方法获批；候选能写入另一项目的工作区；新 MCP 接口没有本轮授权/预算边界，还可以返回未共享任务的私人内容。正常用户的技能评测按钮反而因缺 taskId 被新后端拒绝。

更重要的是：所谓 M1 桌面全流程测试仍由测试代码调用服务、模拟搜索、FakeCodingExecutor 写入预制代码。它确实运行了 Node 检查，但没有实际桌面操作、真实 Hermes/搜索/Codex，也没有把执行结果送回原对话的测试。

**建议保留现有架构，返回 M0 补齐可信边界，再实际完成 M1；不要据此开始扩大无人值守使用或宣称个人 Agent 闭环已完成。** M2 还未在本批交付，不将其正常待办误列为本批新回归；也不取消多话题记忆、主动研究、Door、模型池和成长的长期目标。

## 2. 本轮验证与限制

| 检查 | 本轮实际结果 |
| --- | --- |
| 上轮 bbe651f 独立反例 | 14 通过、0 失败 |
| unit + integration，排除历史评分产物 rescore | 284 通过、12 跳过、0 失败；含新增 M1 的两个服务级用例 |
| 本轮独立检查，最终夹具版本 | 10 项：7 个失败反例、2 个正常对照、1 个“当前 UI 请求必被拒绝”的诊断对照 |
| 类型 / 全仓 ESLint / 项目格式检查 | 通过 |

失败反例是针对代码疑点设计的，不是抽样可靠性统计，不能算成“软件 70% 失败”。诊断对照通过表示成功复现了 UI 参数缺失，**不是**技能 UI 已可用。

测试仅使用合成 SQLite、临时目录、Fastify HTTP 注入和模拟网络；部分命令由受控 Node 子进程真实执行。没有使用日用数据库、真实 API Key、真实付费搜索/模型/编码，没有进行安装升级、真实 Electron 全链或真实进程树验收。不能把本轮复现说成已经发生真实资料泄露、真实费用损失或日用文件损坏。

本轮只增加审核测试、证据与文档，不修业务代码、不改已发布迁移、不提交或发布。

## 3. 必须修复的发现

下列 RR 编号为本报告编号；F01–F08 为本轮测试编号，不覆盖历史同名编号。

### RR01 · P1 · 仍然可以用一句打印证明“技能进步”（F01）

位置：[skills.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:294)。

新逻辑把上轮测试里的 `not testing the failed artifact` 文本写进拦截条件，同时将 `fs/assert/test/exit/existsSync` 等字符串当作有效检查的线索。它没有建立同题对照。

本轮经实际技能 IPC，提供一个有效任务工作区，再运行 `node -e "console.log('assert')"`。命令只打印文字，没有执行候选方法，也没有读取或验证失败产物；评测和批准仍成功，最终返回 `{ok:true}`。

这证明问题根因没有被解决。不能再追加这句话的黑名单。需要实现上轮计划 M0.2：固定输入/用例/独立判据，旧方法与候选实际运行，同一任务比较；记录方法、产物、判据版本与运行绑定。失败历史的非零码加上本次任意命令的零码，不是能力改善。

另一个容易误解的地方：旧 T02 没有 taskId。现在它在进入评测前就被“缺工作区”拒绝，因此旧 T02 变绿本身不能证明同题评测修好了。

### RR02 · P1 · taskId 存在不等于工作区获得正确授权（F02）

位置：[appRuntime.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:1112)。

目前只查 taskId 对应的 workspace_path，验证路径存在、不是与 dataDir 完全相等，然后运行调用方命令。没有核对候选所属项目、失败运行、评测批准、任务版本、允许命令和文件范围。

本轮准备项目 A 的候选，传入项目 B 一个已经排队的合成任务 ID。该任务获准范围只有 `allowed.txt`，技能评测仍成功向 B 的工作区写入 `foreign-canary.txt`。两个项目及文件都只在新建临时目录，不是用户原项目。

修复：主进程创建并保存专用评测请求，把候选版本、基线、项目、受控副本、判据和许可绑定；不能由任意 taskId 选择目录。错误项目、撤销/过期、批准后改动、工作区替换、范围外写入要拒绝。不要恢复 dataDir 回退，也不要只补一个前端下拉框当作后端授权。

### RR03 · P1 · 新 MCP 搜索/读网页绕过本轮权限和预算（F04）

位置：[HTTP 搜索路由](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:416)、[直接执行搜索](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:943)、[读网页](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:960)。

新路由验证通用 localToken 后，直接调用提供方。契约没有可信的运行身份、授权范围、预算预留或取消状态；它也没有转入管理这些边界的统一执行入口。字符串脱敏不能代替搜索授权。

本轮通过真实 HTTP 路由注入请求：新建空库没有任何运行或搜索许可，只提供合成本地令牌，连续四次请求均进入模拟搜索执行器。无令牌对照正确返回 401，所以这里不是“任意远程匿名访问”，而是**已配对的通用客户端得到过宽能力**。

修复：内部 Hermes 与外部 MCP 客户端分开授予能力；在实际副作用处校验服务端产生的短期运行身份、获准范围、当前代次、工具白名单、预算和幂等。没授权、已停止/撤权或超额时，提供方调用次数必须为零。凭证配置成功不等于向所有 MCP 客户端授予使用额度。

### RR04 · P1 · get_task_status 未检查任务内容能否对该客户端公开（F05）

位置：[结果路由](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:489)、[直接读取并返回任务](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:1062)。

只要持有通用 localToken 并知道 taskId，就返回 goal、验证输出、执行报告摘要和改动路径；没有来源/项目受众、任务共享或本轮身份检查。

本轮在无共享授权的合成库插入私人任务标记，经 HTTP 返回了该标记及验证/报告内容。测试不涉及真实隐私内容，也未证明未知任务 ID 可被枚举；问题是知道 ID 不应等于获准读取。

修复：将任务结果视作有受众和来源的资料，对读取者、所属项目/运行及可公开字段做判断，沿用撤权语义。仅状态可见和正文可见可以分级，但不能把完整验证输出当成天然公开的元数据。补错误项目、无授权、撤权、旧运行和合法授权对照。

### RR05 · P1 阶段验收缺口 · M1 的自动化仍不是桌面 Agent 办事闭环

位置：[预制 Fake 产物](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/m1-desktop-action-loop.test.ts:134)、[所谓回交只是读任务](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/m1-desktop-action-loop.test.ts:197)、[任务 IPC](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:501)、[问答入口](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Ask.tsx:14)。

新测试的有用部分：真实落库、Fake 生成文件后由 Node 跑实际断言、未批准和已取消任务不能直接派发。

它未证明的部分：

- NP07 直接调用 McpService 并注入模拟响应，没有经过实际引擎的 MCP 会话。
- NP08 使用 FakeCodingExecutor，去重代码由测试预先提供；没有调用 Hermes 或 Codex，也没有真实搜索。
- 所谓“用户在桌面批准/接受”是测试直接调用 coding 方法；没有打开桌面。
- 所谓“结果回交原对话”只检查 `coding.store.get()` 中的报告字符串，没有验证对话收到事件或引擎继续使用结果。
- 本批没有 renderer 主流程改动；现有任务页仍分开批准、派发、接受，问答页没有由这次提交接上的批准卡/结果联动。新增查询接口本身不等于自动回交。

另有接口对齐欠项：MCP 注册 `get_task_status`，而 [CORE_TOOL_NAMES](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/broker.ts:21) 仍是 `get_task_result`；应统一并用真实会话验证，不能仅增加“已桥接”名单。

修复：保留服务级用例，但如实命名和报告；按照原 M1/NP07–NP08，从真实桌面入口跑一条获准场景，保存引擎工具调用、真实搜索、批准、真实编码、独立检查、结果回原对话及取消/重启证据。缺账号或额度就单列未验证，不能将模拟测试改称真实环境通过。

### RR06 · P2 · 用户的“运行受控对照验证”按钮现在必缺绑定（F03 诊断）

位置：[Tasks.tsx](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Tasks.tsx:306)、[后端新要求](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:1119)。

任务页仍只传 id、command、benefit；后端现在必须有 taskId 和工作区。即使库中已有合法任务工作区，当前 UI 参数也会被拒绝。本轮按实际 UI 参数调用 IPC，确实得到“必须绑定有效的编码任务工作区”。没有进行真实 Electron 点击，此结论由页面参数与实际 IPC 联合确认。

修复应由 Agent/系统准备绑定的评测任务，用户看方案和对照结果，不应继续要求用户手写空格拆分的 Node 命令。必须补正常可成功路径、真实失败路径以及重进页面测试；安全拒绝和用户可用需要同时成立。

### RR07 · P1 · 不给付费预算，定时研究仍调用云渲染（F06）

位置：[渲染分支](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:250)、[只因搜索 Key 可用而创建渲染器](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:616)。

已增加暂停/代次复查，这是有效进步。但渲染没有独立授权和次数/费用限制；`paid_budget_mode=none`、request_cap=0 只阻止了自动搜索，没有阻止云渲染。

本轮创建明确不给付费预算的来源主题，启用后通过公开 `tick()` 调度，静态响应是合成 SPA 骨架，模拟云渲染仍被调用一次。不是实际扣费证据，但确认付费能力调用没有被该预算状态挡住。

修复：静态读取、搜索和动态渲染分别受授权/预算管理；没有渲染授权或额度时只返回静态读取受限，不能因为 Key 存在自动消费另一能力。重试计数，预算在调用前扣/预留，暂停/撤权继续有效。

### RR08 · P2 · 云抓取正文仍无大小上限，空结果仍算成功（F07、F08）

位置：[全量 res.text](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/tinyfishFetch.ts:90)、[内容与返回](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/tinyfishFetch.ts:169)。

超时现在覆盖正文读取，旧反例通过。但仍全量读取，没有实施计划中的 2 MiB 流式上限。本轮超过 2 MiB 的合成正文照常返回；`results:[], errors:[]` 则返回 content=''、status=200，而不是“未取得有效正文”。

修复：边读边限额并主动取消，保留总超时；逐 URL 结果要验证匹配和内容有效性。空正文/缺结果/异常结构不能冒充成功研读。不要只在读完整个大响应后截断字符串。

## 4. 其他未完成项，不应被“全部清零”覆盖

- Q05 的实现仍混用 id/client_ref/逗号字符串，评测仅取第一个来源；它修复了原两个反例，但没有按 M0.4 建立明确一对多关系和所有基线的校验。当前不能称完整关联模型已实现。
- watchdog 现在调用 kill，旧 spy 对照通过；没有本轮真实进程树结束与资源释放证据。调用 kill 不是等待全部资源已结束的证明，不将此记成新实测进程泄漏。
- 迁移 23 对旧 `auto_discovered` 标记修复通过；最新真实非空旧库副本升级、已丢失来源身份的保守处理仍需按计划验收。
- `scripts/verify.mjs` 没有新增 bbe651f 审核配置；默认 unit/integration 也不包含 `test/review`。因此 M0“新回归接入默认 verify”的要求未完成。本轮未运行完整 verify。
- M2 的多话题自动记忆、三项目正反联系、持续研究质量、下一任务实际使用 Skill、交付恢复仍是待办，不能因包号 0.2.9 混同已验收。
- 本轮没有安装或检查安装器产物，不断言 v0.2.9 已安装在用户机器。发版记录与包哈希只能证明其所记录的打包事实，不能替代阶段验收。

## 5. 对开发方向的判断与修复顺序

Core 自有、Hermes 可替换、MCP 回交、受控编码这个方向不需要推倒。当前偏差是**按测试表面结果交付，却没有按真实行为验收**。硬编码原反例文字、把 Fake 流程描述成桌面流程，会让每次报告看起来完成，用户实际体验却没有跟上。

建议下一位开发 Agent 按以下顺序返修，不另起一个更大的重整：

1. 先修 RR01–RR04/RR07：可信评测、工作区绑定、MCP 运行权限与预算、任务结果受众、云渲染预算。合法路径与越权反例成对验收。
2. 同步修 RR06/RR08，关闭正常入口不可用及无效正文问题；补齐 Q05 的关联模型。新迁移从当前 23 后追加。
3. 将审核回归接入默认入口，保存失败原件；修正 REVIEW_PACKET §57–59、开发日志和发布说明的完成口径，追加说明不抹掉历史。
4. 再按既有计划做真实 M1，尤其是原对话批准/结果回交。一次只跑最小获准场景，缺权限列清，不要求用户自己写程序或补网址。
5. M1 通过后继续原 M2；个人 Agent 的广度没有取消，不把安全修复变成永远不交付产品的理由。

当前继续使用 [2026-09-15 下一阶段计划](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_下一阶段开发计划_目标驱动个人Agent闭环_2026-09-15.md)，不需要再换一套愿景。验收标准也不是今天新增的：以上可信绑定、有效对照、运行预算与真实桌面均在该计划中明确提出。

## 6. 证据、复现与审核夹具说明

- [最终独立测试源码](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/review-f71da15-20260916.test.ts)
- [最终反例结果 checked-v2](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-f71da15-independent-checked-v2-20260916.json)
- [旧反例复跑](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-f71da15-prior-20260916.json)
- [基础回归](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-f71da15-baseline-20260916.json)

本轮夹具初跑的 `independent-draft` 与 `independent-checked` 文件也保留：其中 F06 错用了私有 runTopic 的参数，导致未启用错误，不能作为产品预算缺陷证据；F03 初版把 UI 调用期待为成功也不够严谨，现改为缺绑定的诊断对照。最终改用公开 setEnabled + tick，F06 确认为一次真实到达模拟渲染器的调用。**本报告只以 checked-v2 的最终夹具结果作为新反例统计。** 夹具修正后 tsc 重新通过。

PowerShell，仓库根目录；以下只运行本轮合成审核，不开真实服务。修复后输出另存为 fixed，不能覆盖 checked-v2：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.review-f71da15-20260916.config.ts --reporter=json --outputFile=apps/desktop/test/review/results-f71da15-independent-fixed-20260916.json
```

默认回归运行时已将 IXAEON_REAL_HERMES/CODEX/SEARCH/NET/DAILY_DB 全部设为 0，清空专属引擎定位变量，并排除 memory-eval-rescore，避免触碰真实环境或改写历史评分产物。Windows 沙箱辅助目录故障时，经批准使用沙箱外工具做这些限定的读取、隔离测试和审核文档写入，没有更改系统 ACL 或扩大业务权限。
