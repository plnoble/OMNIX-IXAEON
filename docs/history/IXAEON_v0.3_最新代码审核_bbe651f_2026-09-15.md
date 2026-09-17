# IXAEON 最新代码审核：bbe651f

日期：2026-09-15。基线：`bbe651f`。审阅范围：上轮 `93ecaed` 之后的修复及 TinyFish、网关守护、失败聚类新增代码，结合当前实际桌面入口判断方向。

## 1. 结论

**上一轮具体反例修好了不少，但目前仍不能验收为完整的个人 Agent。可以继续开发，不能直接据此进入正式自我升级或无人值守执行。**

架构方向仍可保留：Core 掌握自己的资料、权限、任务和经验，Hermes 是可替换的运行引擎。主要问题在交付顺序与验证方式：主流程还没接好，就继续接新项目；测试证明了一些零件，却被描述成完整办事能力。

尤其需要警惕两件事：

- “命令真的运行过”不代表“方法真的改善了”。这次虽然不再相信调用方填写的退出码，但一个只打印文字、完全不检查产物的命令，依然可以让技能获批。
- “有安全限制”不代表“限制的目录选对了”。技能评测没有绑定任务时，实际允许脚本读写应用数据目录。

**不建议推倒重来。建议按配套的下一阶段计划分三批：可信边界 → 真实桌面办事 → 多话题日用验证。** 本阶段仍属于 V0.3 重整，不因多了几个工具就提前宣布 V0.4。

配套文件：[下一阶段开发计划](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_下一阶段开发计划_目标驱动个人Agent闭环_2026-09-15.md)。

## 2. 本轮证据与边界

开始时工作区干净。只新增隔离审核测试、结果、审核报告及计划，并追加交付导航记录；不修业务代码、不改已发布迁移、不读取或迁移日用数据库、不配置真实凭证、不安装或发布。

检查过官方公开文档，但没有通过 IXAEON 调用真实搜索/云渲染/模型/编码服务。涉及命令的新增测试只在本轮新建的合成临时目录运行 Node；清理前校验绝对路径，不触碰用户数据。

| 检查 | 本轮结果 |
| --- | --- |
| 上轮二次复审 | 12/12 通过 |
| 9 月 14 日历史反例 | 12/12 通过 |
| 9 月 13 日历史审核 | 15/15 通过 |
| 9 月 11 日历史审核 | 20/20 通过 |
| unit + integration，排除会改写历史评分产物的 rescore | 282 通过、12 跳过、0 失败 |
| 本轮新增独立检查 | 14 项：2 对照通过、12 针对性失败 |
| 类型检查、全仓 ESLint、项目格式检查 | 均退出码 0 |

新增检查针对代码疑点，不是随机抽样，不能用 12/14 计算产品失败率。既有 59 项独立审核通过，说明此前修复有效；也不等于所有产品行为已完成。

本轮未运行完整 verify、真实 Electron 界面流程、真实 Hermes→搜索→Codex 全链、真实模型三轮记忆评测、安装器、最新迁移的真实旧库升级。这里没有实测真实隐私外泄、日用数据损坏或真实孤儿进程。

## 3. 可以接受的具体进步

- 新建研究的 camelCase→snake_case 转换已补齐，上一轮预算/间隔保存反例通过。
- 新增迁移 22 的来源身份字段，新建自动来源跨周期不再因清空错误状态而丢失身份；旧数据迁移另见 Q07。
- 授权自然到期、纠正、来源撤权、应用退出相关旧反例通过。上下文生命周期仍需真实连续会话验收，不能从辅助函数推导所有情况已覆盖。
- 模型研读有 8 次调用上限；模型失败的降级信息不再完全静默；真实记忆评测已改用生产 ContextSelector。
- 旧的“调用方提交退出码即可批准”入口已改为主进程执行命令，属于进步；但工作区绑定和对照有效性仍有严重缺口。
- 静态门禁恢复通过。历史 checked 结果仍在，不应为了门禁改写它们。

## 4. 需要修复的事项

以下 Q01–Q08 是本报告编号；T01–T12 是新增测试编号，不覆盖历史计划中的同名编号。P1 优先于扩大真实数据与无人值守使用；P2 也是本阶段交付必须补齐的可靠性问题。

### Q01 · P1 · 技能评测默认获得应用数据目录读写权

位置：[appRuntime.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:1086)、[验证器](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/execution/executor.ts:708)、[任务页](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Tasks.tsx:306)。

T01 经真实 IPC 处理器调用技能评测，未传 taskId——与当前任务页相同。主进程使用 `cwd ?? (this.dataDir || process.cwd())`；验证器据此授予整个 cwd 的读写权限。合成脚本成功在模拟应用数据目录写入 canary 文件。

这不是证明 Node 限制完全没用：对照测试证明确实不能写出指定 cwd。问题是把应用数据目录本身当成允许写的评测目录。

即使传 taskId，当前只读取该任务的 workspace_path，没有核对候选、项目、失败基线、批准与工作区之间的绑定关系。

修复：没有有效评测工作区就拒绝，绝不回退 dataDir/cwd。由主进程建立专用受控副本并保存绑定；界面只传评测请求 ID，不能用任意任务 ID 切换范围。评测器和答案不能由候选修改。增加无绑定、错误项目、过期批准、被替换工作区和数据目录不可读写的行为测试。

### Q02 · P1 · 换一个无关的成功命令，就能“证明技能改善”

位置：[skills.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:233)、[实际运行](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:288)、[桌面评测输入](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Tasks.tsx:306)。

T02：准备一条有非零验证退出码的合成失败记录，为候选提供仅 `console.log(...)` 的命令。没有运行候选方法，没有检查原失败产物，仍可评价并批准，返回 `{ok:true}`。

原因：before 只取旧记录的退出码，after 则执行本次任意命令；两边没有绑定同一份用例、成功判据、输入和环境，也没有证明候选方法实际参与执行。`producedBy=controlled` 只能说明命令由谁运行，不能证明运行了正确的测试。

任务页还要求用户手工输入命令，并默认填 `node -e process.exit(0)`。后端已拒绝这一特定占位命令，因此默认操作会失败；但换成打印文字的其他空检查又能通过。这不是继续维护“坏命令关键词黑名单”能解决的。

修复：固定任务相关评测用例和独立判据，在同一用例上执行旧方法/新方法；记录方法哈希、用例版本、输入、环境、输出及真实执行 ID。任何没跑、换题、检查被改、候选未使用、产物缺失，都不得显示改善。让 Agent 提出方法并请求实际评测，用户审阅差异，而不是替 AI 编写验收命令。

### Q03 · P1 · TinyFish 接口实现与当前官方契约不匹配

位置：[搜索实现](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/webSearch.ts:197)、[抓取实现](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/tinyfishFetch.ts:75)、[返回解析](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/tinyfishFetch.ts:122)。

2026-09-15 核对的官方文档与当前代码如下。这个比较针对文档协议，没有使用真实 Key 探测线上服务：

| 项目 | 当前实现 | 官方文档 |
| --- | --- | --- |
| Search | POST `https://api.tinyfish.ai/v1/search`，Bearer，JSON 查询 | GET `https://api.search.tinyfish.ai`，`X-API-Key`，查询参数 |
| Fetch | POST `https://api.tinyfish.ai/v1/fetch`，Bearer，`url` | POST `https://api.fetch.tinyfish.ai/`，`X-API-Key`，`urls` 数组 |
| Fetch 返回 | 顶层或 data 中读取 content/markdown/text | `results[]` 中读取 text；`errors[]` 可携带单 URL 失败 |

来源：[TinyFish Search API Reference](https://docs.tinyfish.ai/search-api/reference)、[Fetch 官方接口](https://docs.tinyfish.ai/api-reference/fetch-and-extract-content-from-urls)。

T03/T04 用官方形状的合成请求/响应验证，当前请求不匹配，官方形状的正文被解析为空。T05：HTTP 200 但 errors[] 表明目标 404，当前仍返回空正文和 status=200。

现有 TinyFish 单测主要按实现自己的假定返回响应并断言同样的地址，不能用它证明兼容官方接口。除非有其他实际获准网关契约及成功证据，否则不能把这条接入标为真实可用。

修复：锁定文档/SDK或 OpenAPI 的实际版本，按真实契约适配并保存最小脱敏协议样本；覆盖正确返回、逐 URL 错误、空内容、认证和限流。真实连通仍需有效凭证和明确额度授权，不在无权限时偷偷测试。只需修好一个已有选定入口，不继续添加第四、第五个提供方。

### Q04 · P1 · 新云渲染绕开了部分暂停、超时和错误报告边界

位置：[checker.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:224)、[云渲染分支](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:243)、[响应正文](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/tinyfishFetch.ts:96)。

- T06：静态请求进行时暂停主题，响应晚到后仍发起一次新的云渲染。最后 run 变为 cancelled，不能抵消此前已经发生的新外部调用。
- T07：云渲染抛出额度错误，异常被 catch 丢弃，SPA 骨架仍可使整轮显示成功且 error=null。
- T08：收到响应头就清除超时，等待正文期间超时信号不再触发；全量 `res.text()` 也没有流式大小上限。

静态还发现云渲染没有独立的次数/成本额度，不能拿“搜索额度”或“8 次模型调用”当成它的预算。配置 Key 不应使不同用途的付费能力自动获得无界许可。

修复：在每次外部副作用之前重新核对运行代次、授权、预算；贯穿请求头与正文的超时、大小上限和取消信号；记录实际渲染调用和错误。允许部分结果，但明确“动态正文未取得”，不能把骨架当成已读懂的网页。云渲染可选且默认未授权，批准范围内自行选来源，不回到逐 URL 手工审批。

### Q05 · P2 · 失败聚类生成的候选与评测器对不上运行记录

位置：[聚类去重](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:88)、[保存来源](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:165)、[基线查找](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:262)。

当前同一字段有三种用法：编码失败生成候选保存 client_ref；聚类保存多个 work_runs.id 用逗号拼接；评测器却始终用单个 client_ref 查找。

T09：两条同类失败聚成一个候选，评测器找不到基线，真实验证分支根本未进入。T10：已有按 client_ref 关联的编码失败，聚类按 id 做字符串匹配，仍重新提案。

另一个入口也需修：任务卡手工“提炼为能力候选”没有传任何 workRunId，候选缺基线，不能按新规则继续评测。

修复：以明确主键和关系表/有类型的关联结构保存一对多来源，不能让一个字符串混装 id/client_ref/逗号列表。迁移兼容旧候选、幂等、按项目隔离；从真实失败卡、自动聚类、评测到批准逐条打通。聚类只是发现线索，不能把模板文本称为已完成研究或自我进化。

### Q06 · P2 · watchdog 报失败，并不等于停止了底层进程

位置：[waitTerminal](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/tuiGateway.ts:278)、[end](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/tuiGateway.ts:467)、[适配器异常路径](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/adapter.ts:159)。

T11 用可握手但之后不输出的协议替身推进虚拟时钟，watchdog 的确把 run 标失败，但 transport.kill 没被调用。end 只修改状态/通知 Promise；适配器 catch 删除 resident 引用，没有先释放进程。

这是受控协议接线证据，不是已观察到真实 Hermes 孤儿进程。新增的“进程异常退出即刻报错”测试与“本机主动超时后能杀掉还活着的进程”是两件事。

修复：统一失败/超时/取消/退出的终态清理，等待本轮进程树结束后再丢弃引用，保留具体原因，不重复执行。用本地合成子进程验证退出；不要杀用户其他进程。正常长任务也不能仅因模型暂时无输出被误判，超时策略需可观察且有合理上限。

### Q07 · P2 · 迁移 22 没有保留能识别的旧自动来源

位置：[迁移 22](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/db/migrations.ts:703)。

T12 从迁移 21 的合成库开始，来源明确留有 last_error=auto_discovered。升级后 discovered_by=user，已知的自动来源被改成用户批准来源。

新建自动来源的对照通过，不能替代旧库升级。部分更旧记录的临时标记已被清除，不能再假装可以百分百还原其来源。

修复：以当前最新版本 22 为起点新增迁移，不改已发布 22。能从旧标记/可靠审计确定的记录修正为 auto；无法确认的保守处理并说明缺口，不直接扩大成“用户指定”。补 21→最新及已升到22→最新两条路径，保留真实用户来源和历史记录。

### Q08 · P1 阶段验收缺口 · 仍缺“从桌面对话真正办成事”的证据与接线

位置：[当前桌面问答桥接](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:770)、[MCP 注册](D:/Agent/Project/OMNIX-IXAEON析衍/apps/mcp/src/shared.ts:167)、[所谓全链测试](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/s2-07-agent-action-loop.test.ts:38)。

本次新增的 s2-07 测试有价值，但它由测试程序按步骤调用服务、使用 FakeCodingExecutor、由测试直接写入“修复产物”，最后只查询 approvedForProject。它没有打开桌面，没有真实 Hermes 决定并调用工具，没有真实搜索和 Codex，也没有执行下一次任务验证该方法确实被使用。验证命令只看文件是否含 valid 字样，更不能证明版本比较函数正确。

当前桌面明确桥接仍只有新增的两个 Core MCP 工具，完整研究/提案/结果回交路径没有因这个测试而补齐。普通记忆的 Inbox 查询与原存储管线也未在本批重做，修改问答结束提示不等于默认流程已完成减负。

必须保留历史真 Hermes 对话、MCP 单工具和真 Codex 文件探针的价值；也必须承认它们还不是一条真实桌面路径。

修复与下一批验收：见配套计划。先让 Agent 在真实入口读 Core、研究、提出具体任务；用户批准后真实执行、独立检查，结果回到原对话；再验证多话题记忆、三个项目的正反关联与一次真正的方法改进。不能通过删批准、改用 Fake 或让用户手工复制提示词来“接通”。

## 5. 对开发方向的判断

TinyFish 可以是网页能力适配器；网关守护和失败归类可以改善可靠性。但它们都只是手段，不是“已经成为个人 Agent”的证明。Vermes/Mobius 的项目名不自动带来它们的整套能力，本仓库当前只是借鉴部分设计模式。

我会质疑的是优先级：B1 真实主流程尚未完成，持续增加外围能力会让系统看起来更大，用户体验却仍是填表、点按钮和管理候选。应该停止这种扩张顺序，不是取消长期野心。

下一阶段必须让用户感到三点：平时自动理解且不烦人；只说目标就能看到研究和执行进展；改变方法有真实证据，用户只做关键决定。

## 6. 复现与交付证据

新增测试：[review-bbe651f-20260915.test.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/review-bbe651f-20260915.test.ts)。

原始结果：[独立反例](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-bbe651f-independent-checked-20260915.json)、[静态门禁](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-bbe651f-gates-20260915.json)、[基础回归](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-bbe651f-baseline-20260915.json)。

历史复跑：[二次复审](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-bbe651f-direction-round2-93ecaed-20260915.json)、[0914](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-bbe651f-direction-recheck-20260914-20260915.json)、[0913](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-bbe651f-restructure-20260913-20260915.json)、[0911](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-bbe651f-direction-quality-20260911-20260915.json)。

PowerShell，仓库根目录；修复后另存新结果，不能覆盖 checked 原件：

```powershell
$env:IXAEON_REAL_HERMES='0'
$env:IXAEON_REAL_CODEX='0'
$env:IXAEON_REAL_SEARCH='0'
$env:IXAEON_REAL_NET='0'
$env:IXAEON_REAL_DAILY_DB='0'
$env:IXAEON_HERMES_HOME=''
$env:IXAEON_HERMES_EXE=''
$env:HERMES_HOME=''
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.review-bbe651f-20260915.config.ts --reporter=json --outputFile=apps/desktop/test/review/results-bbe651f-independent-fixed-20260915.json
```

测试可因更好的架构改为等价行为断言，但必须说明旧风险被怎样覆盖；不能删除失败用例后称修复。当前审核环境 Node v24.14.0。业务源码、日用库和正式安装未改动。
