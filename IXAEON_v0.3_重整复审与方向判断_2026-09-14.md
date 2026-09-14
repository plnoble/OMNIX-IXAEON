# IXAEON 重整复审与方向判断 — 2026-09-14

审核基线：Git `04f70a3`，重点对比上次审核基线 `47e1f8e`。桌面源码版本为 0.2.8；版本号不代表重整验收通过。

本次只审核，未修改业务代码、日常数据库、授权或已安装应用；未调用真实模型、搜索服务或 Codex，也未发布。新增了隔离测试和本报告。

## 一、先说结论

**技术架构正在靠近我们讨论的方向，但用户实际使用的流程还没有到位。本轮不能验收为“重整完成”或“A01–A10 全部闭环”。**

不建议推倒重来。Core 自有数据、Hermes 适配、资料历史、任务隔离和独立核验都有可继承价值。上轮两组审核用例本轮分别 15/15、20/20 通过，修复不是毫无效果。

但目前仍更接近“带 Agent 接入的个人资料与任务工作台”，尚不能称为可靠的个人 Agent 内核。差距不只是界面好不好看，而是：

1. 普通记忆依然容易变成用户要处理的卡片，无关的临时要求还能进入新问题背景。
2. 自动研究的预算设置没有进入日常界面，桌面的研究判断器也没有接入模型。
3. Hermes 能对话，不等于它已通过 Core 受控地完成研究、提出任务、等待批准、执行、验证、积累经验。
4. 新增工具出现了受众权限混用；持续会话也没有随撤权更新旧上下文。
5. “学习后的方法经过验证”仍可由文字声明冒充。

**建议保留架构，暂停扩模块，先完成下面的修复与一条真实桌面闭环。**

## 二、与最终方向的关系

| 你真正要的东西 | 当前判断 |
| --- | --- |
| 以你为中心，理解多个项目和想法 | 已有个人视角和跨项目数据基础，但还不能证明持续、主动统筹 |
| 自动理解聊天，不逐条布置确认作业 | 自动存档、提取已有；首页有所减负，待讨论入口及部分工具仍沿用旧确认工作流 |
| 有关时记起，无关时不硬扯 | 有统一选材服务，但项目兜底会绕过临时记忆过滤；连续会话也需治理 |
| 给一个方向，自己找资料并判断价值 | 搜索和定时处理底层已有；生产预算入口、模型研读和完整用户行为未打通 |
| 调用编码 AI，在批准边界内办事 | 历史已有真 Codex 独立任务记录；对话驱动的 Core 全链路仍未充分接通、核实 |
| 从失败中学习，下次做得更好 | 候选、版本、批准和注入接口已有；实际评测来源与版本绑定不可靠，缺可用的完整产品流程 |
| 换引擎仍保留自己的数据 | 分层方向正确；新增工具及会话生命周期尚未达到这个承诺 |
| 四平台、手机、NAS、模型池、受控升级 | 应保留在长期路线；不是当前必须全部实现，但不能把项目缩成单项目交接工具 |

四平台“文件导入支持”不等于自动读取所有账号、所有历史对话。其他平台真实样本延后，是验收记录中已有的用户决定，本次不以缺这些样本单独判开发失败。语义检索、Door、模型池等也不应靠换名字宣称完成。

## 三、确认有进步的部分

- 上轮工具名称匹配、本地重复调用、原文模型受众、存档撤权、验证器和删除差异等具体反例已转绿。本轮独立复跑了两组历史审核。
- 问答存档有独立设置开关，停用状态可以保存，不再普通提问就隐式恢复授权。
- Hermes 增加长驻会话和运行中的账本记录。历史真机材料证明了固定回答、追问上一句等能力；这与完整办事链的证明应分开。
- 增加 ContextSelector、ResearchJudge、Skill 版本字段。它们是有意义的基础，但存在调用链或边界缺口。
- 本轮类型检查、ESLint 和源码格式检查通过。

这些进步足以支持继续做下去，但不足以支持“全部闭环”的交付声明。

## 四、需修复的问题

P1：进入更多私人数据、无人值守或正式交付前优先解决。P2：本阶段行为验收必须解决，不应以功能名称掩盖。

### D01 · P1 · 新 MCP 读取工具混用了“主模型”和“编码客户端”的授权

位置：
- [mcpStore.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:879)
- [localServer.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:387)
- [shared.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/mcp/src/shared.ts)

复现 C01：创建个人条目，只给予 `model` 分享，不给予 `coding_client` 分享。旧 `getSourceExcerpt` 拒绝；新 `getEvidence` 却返回内容。

原因：新增通用 MCP 路径使用 `modelMayReadItem`，HTTP 入口只核对同一个 localToken，没有认证出“这是被批准的主 Agent 模型运行”。普通 MCP 客户端也能调用该路径。

边界说明：不是匿名互联网读取漏洞；前提是持有有效本地令牌并知道条目 ID。本轮使用合成数据调用生产服务方法，没有读取或外发真实个人内容。

修复要求：主 Agent 工具身份与通用编码客户端身份分开；受众由可信调用身份决定，不能由工具名称或模型参数决定。旧编码客户端不能因为新增工具得到 model-only 个人资料。

验收：model-only、coding-only、两者皆无、到期、撤销各组合覆盖 HTTP/MCP 的新旧工具路径；不能仅给新方法补一个无区分的“允许”判断。

### D02 · P1 · 连续会话复用了旧背景，但没有跟随权限变化失效

位置：
- [adapter.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/adapter.ts:127)
- [session.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/session.ts:161)
- [ipc.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:372)
- [appRuntime.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:1034)

复现 C08：同一个 personal context，权限版本从 1 改成 2，仍使用同一模拟引擎 session ID。生产调用还把 permissionVersion 固定为字符串 `1`，撤销分享入口只更新数据库，没有失效运行中的上下文。

这意味着：即使下一轮查询不再选出被撤权资料，它仍可能留在 Hermes 旧会话里。不能把“检索过滤正确”当成“后续模型请求不再带旧资料”。

另外，`disposeAll()` 虽存在，AppRuntime 停止/重建路径未见调用；当前问答复用对象持有创建时的 broker/provider，配置变化与数据恢复也需统一处理。

修复要求：建立有效的权限/上下文版本与会话生命周期；撤权、敏感纠正、配置切换、恢复、退出时清理或重建相应会话。无法可靠移除旧上下文时结束旧运行，以获准内容开新会话。不能承诺撤回已经发给外部服务的数据。

验收：先读入合成秘密→撤权→继续追问，检查实际出站上下文和会话失效；另验纠正、换项目、重启、停止和恢复。C08 只证明当前版本变化未触发重建，未模拟真实模型的后续泄漏。

### D03 · P1 · Core 工具桥仍不完整，直连 MCP 新工具实际报“未知端点”

位置：
- [direct.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/mcp/src/direct.ts:25)
- [shared.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/mcp/src/shared.ts)
- [tuiGateway.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/tuiGateway.ts:307)
- [broker.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/broker.ts:175)

复现 C09：共享注册表已公开 `get_evidence`、`record_observation`，但 direct.ts 的实际路由仍只有原四个端点。对原摘录工具调用成功，对新增证据工具调用返回“未知 MCP 端点”。这是仓库/无头直连路径问题，不能混同为已实现 HTTP 路径也完全不可用。

还有静态确认的缺口：

- 桌面明确桥接的新增工具仅为两个；`search_web/read_web/propose_task/get_task_result` 等 Core 工具未见完整对应的 MCP 注册。
- 非 MCP 路径在 `tool.start` 后调用本地 broker，只把结果写入 IXAEON 事件，并没有通过该通知路径把 Core 结果回给引擎继续思考。
- MCP 真正执行入口未绑定本轮 runId、调用预算和调用幂等键；本地通知分支的四道检查不能证明实际 MCP 副作用也受同一约束。
- `propose_task` 的验证命令仍固定检查非空 note.txt。换成真实项目目标时，这个默认判据不成立。
- 引擎自己的搜索或终端工具即使能工作，也不能直接算作“IXAEON Core 已受控接通”。

修复要求：统一工具定义与实际执行服务，适配器只转协议；模型必须拿到真实工具结果，身份、预算、取消、幂等在产生副作用处检查。个人记忆写入不应强制 project_ref，也不应全部变成待确认 open_loop。

验收：从桌面对话出发，用合成 Core 资料、获准真实搜索和获准文件任务，记录引擎读到的工具结果→提出任务→用户批准→真实执行→独立核验→结果回 Core。批准前拒绝执行是正确的，不要为“打通”删除批准机制。

### D04 · P1 · 自动研究仍未从日常界面接通，桌面研读器没有模型

位置：
- [Research.tsx](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Research.tsx:89)
- [ipc.ts 契约](D:/Agent/Project/OMNIX-IXAEON析衍/packages/contracts/src/ipc.ts:489)
- [appRuntime.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:156)
- [checker.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:49)

代码链确认：

1. 定时搜索要求 `paid_budget_mode=request_cap` 且余额大于零。
2. 研究页创建参数与公开 IPC 类型没有对应预算入口；创建默认 none/0，也没有日常补充预算入口。
3. 界面仍说明“手动检查找候选、批准网址后读取、定时不消耗搜索额度”。
4. 正常启动与恢复时，两处 `new ResearchChecker` 都未传入第五个模型参数。ResearchJudge 因此只走关键词规则。
5. 即使以后接入模型，目前调用异常也会静默退回规则；不应继续显示成已完成模型研判。

因此，测试直接构造带预算 checker，或单独给 ResearchJudge 塞 FakeProvider，不能证明用户只给方向后产品会自主研究。

修复要求：提供一次性领域/公开描述/频率/搜索与研读预算授权；之后在范围内自行找来源，不逐 URL 批准。接入可更新的模型或受控 Runtime 研读，记录真实服务、费用/次数、降级原因。没有授权不得为了完成测试擅自外发研究问题或个人背景。

验收：只在界面给方向和授权，不预置 URL；下一次定时运行找到新来源、判断对目标有什么意义、提出最小实验。无配置、无预算、模型失败要如实显示。

### D05 · P2 · 情境记忆仍会硬塞临时内容，也丢掉冲突标识

位置：
- [contextSelector.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/memory/contextSelector.ts:164)
- [Inbox.tsx](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Inbox.tsx:15)
- [appRuntime.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:774)

复现：

- C02：项目里只有“这次会议，马来西亚放在中间，仅本次”；问“数据库索引该怎么优化”，这条临时要求仍进入上下文。原因是前面的临时过滤后，项目兜底又从未过滤集合取回条目。
- C03：两个标记 disputed 的相反数据库约束都进入 prompt，但冲突状态消失，只显示“用户指定”。模型不能可靠区分已生效约束与未解决冲突。

产品体验也尚未统一：个人总览已过滤普通提取，但 Inbox 仍查询全部 needsReview；问答成功提示和 MCP 记忆工具仍强调候选待确认。不是说每条记忆都完全不可用，而是它们仍会给用户造成逐条处理的负担。

修复要求：所有兜底也遵守适用范围和临时过滤，允许零记忆；prompt 保留暂定/已确认/冲突/依据等必要语义。统一“需要用户决定”的队列规则，保留历史 needs_reasons，不把普通暂定理解当作必须清零的任务。

验收：临时 PPT 要求不影响技术咨询；自然改口后旧结论不继续支配；普通聊天不刷一堆确认项；真正的冲突与执行授权仍可见。

### D06 · P2 · 自动来源第二轮会失去筛选，暂停后晚到结果仍能登记来源

位置：[checker.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:155)

- C06：第一轮自动找到无关页面，正确不生成发现；第二轮搜索预算用完，但该来源还在，竟生成一条无关发现。原因是 autoSourceIds 只存在于单轮内存，下一轮自动来源被当作用户批准来源。
- C07：搜索尚未返回时暂停主题；最终运行虽标 cancelled，晚到候选仍先登记到 sources。以后恢复会继续处理这些本应作废的来源。

修复要求：持久保存来源的发现方式、授权依据和筛选语义；执行副作用前检查 generation/取消状态。已发生的请求可以如实计费，取消不应假装能把已经发出的请求撤回，但晚到结果不能成为新的有效输入。

验收：至少连续两轮、重启后、预算耗尽、暂停期间返回四种场景；有效未变化页面继续保持去重。

### D07 · P1 · “有评测证据的学习”仍能被文字绕过，而且缺完整使用入口

位置：
- [skills.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:159)
- [appRuntime.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:1228)

复现：

- C04：旧 evaluate 只填 `failed / passed / improved`，没有 eval_evidence_json，approve 仍通过。
- C05：方法 A 写入证据→改成从未测试的方法 B→旧 evaluate 填文字，仍可批准 B。旧证据没有与方法版本失效绑定。

新 evaluateWithEvidence 接收调用者提供的退出码和输出；没有追溯到受保护的评测运行、用例及方法内容。因此“存成 JSON”不等于客观、不可改写的证据。

新增的列出/批准/撤回只有 IPC 接口，renderer 中没有对应调用。evaluateWithEvidence 与 updateMethod 的调用方目前也只见测试，尚不是用户可用的完整学习流程。已批准的方法会进入项目背景/编码派发，所以这里不能把文字包装当作验证。

修复要求：由独立评测器生成可追溯运行记录，绑定候选版本、方法哈希、用例版本、前后产物和实际输出；任何修改使旧批准与评测失效。旧文字只能当说明。提供让用户看懂的收益/限制/批准版本入口，不要求用户手工填退出码。

验收：真实失败触发候选；候选不能修改验收题或伪造运行记录；方法变更后必须重测；无收益不启用；批准后下次同类任务确实使用，撤回后不再注入。

### D08 · P2 · 证据口径仍领先于实际产品，有一项离线测试依赖安装环境

位置：
- [memory-eval-real.test.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/memory-eval-real.test.ts:128)
- [a06-core-unified.test.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/a06-core-unified.test.ts:204)
- [dev-log-v03.md](D:/Agent/Project/OMNIX-IXAEON析衍/docs/dev-log-v03.md:523)

具体问题：

- 生产 Hermes 问答已改用 ContextSelector；真实模型评测入口仍用旧 selectRelevantItems，且每题独立会话。旧三轮成绩不能证明现在的选材和持续会话正确。
- a08 测试名写“第二次检查无新内容或内容无关”，实际无关场景只 tick 一次，漏掉 C06。
- a09 测试把手写的退出码和输出称为“真实前后对照评测”，没有真实执行这组评测。
- 离线 A06 协议替身测试仍经过真实 locateHermes。清空 Hermes 安装定位变量时，一项测试失败；仅给它一个现有 Node 路径作为模拟定位条件，同一纯协议替身测试 4/4 通过。它应该自行模拟能力探测，不依赖开发者机器恰好装过 Hermes。
- 开发日志写“A01–A10 全部闭环/未完成无”，与上述生产缺口不符。B/R 验收映射也需同步最新真实状态。

修复要求：更正声明，不覆盖历史失败；用生产调用链评测，并加入持续会话、撤权、第二周期、UI 预算和版本证据反例。真实 Hermes 回答固定短语属于连通性证明，不等于完整个人 Agent 已验收。

## 五、本轮实测证据

| 检查 | 本轮结果 | 如何理解 |
| --- | --- | --- |
| 2026-09-11 历史审核 | 20/20 通过 | 旧具体反例未回归 |
| 2026-09-13 历史审核 | 15/15 通过 | 上轮修复有效，但覆盖并不充分 |
| unit + integration 离线回归 | 273 通过、1 失败、12 跳过 | 关闭真实调用、清空 Hermes 定位；失败是上述安装依赖 |
| A06 协议替身，用模拟定位条件复测 | 4/4 通过 | 未启动 Hermes，不冒充真机 |
| 本轮新增独立审核 | 12 项：9 失败、3 对照通过 | C01–C09；不是 9 个测试框架故障 |
| 类型/ESLint/源码格式 | 通过 | 不能代替功能和安全验收 |

没有运行完整 verify、桌面 E2E、真实模型/搜索/编码、安装升级或真实旧库迁移。本轮也没有证明当前安装包包含这些最新修复。历史真人编码接受记录与本轮源码审核分开。

为保护历史评测材料，离线回归排除了会写旧 corrected 结果的 memory-eval-rescore.test.ts；不把这项写成已复跑通过。

新增审核测试：[direction-recheck-20260914.test.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/direction-recheck-20260914.test.ts)。

最终原始结果：[results-direction-recheck-20260914-final-checked.json](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-direction-recheck-20260914-final-checked.json)。

其他结果同目录：
- results-review-20260914-baseline.json
- results-restructure-20260914-rechecked.json
- results-direction-quality-20260914-rechecked.json
- results-a06-synthetic-locator-20260914.json

新增反例复跑（仓库根目录）：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.direction-recheck-20260914.config.ts --reporter=json --outputFile=apps/desktop/test/review/results-direction-recheck-20260914-fixed.json
```

修复方使用新的结果文件，不覆盖 checked/final-checked。三个对照场景为：同权限连续会话、未披露个人信息被两条读取路径拒绝、相关且未变化页面不重复报告。

## 六、下一批怎么推进，才不会越做越窄

不要再以“又加了几个类/接口、测试全绿”作为主交付。按三个小交付推进：

### 交付 1：可靠接线

先修 D01–D03，完成有身份、有权限版本、有预算、可取消的真实工具回路。模型能拿到 Core 工具结果；一般 MCP 客户端不能借主 Agent 权限读个人资料。修好会话释放和环境依赖测试。

### 交付 2：从桌面跑通一个日常场景

用户只说：

> 帮我研究一个对 IXAEON 有用的新技术。先判断是否适合；有价值就给我一个小实验，批准后再做。

用户只需确认一次研究范围/服务/预算，以及具体实验执行批准。Agent 自己查自己的项目背景、搜索、筛选、读资料、比较、说明价值、提出可检验任务；批准后真实编码并独立检查。无需用户给 URL、逐条确认普通记忆或编写验证命令。

同时用“临时 PPT 要求不污染技术问题”“没有有价值更新就保持安静”作为负向验收。完成 D04–D06，不只是演示一个正确答案。

### 交付 3：把经验留在自己这里

修 D07–D08。用一次真实失败建立经验候选、真实对照、用户批准具体版本，再证明下一次任务用到了它。退出/重启/换引擎后，资料、权限、研究队列和经验仍由 Core 保存。

缺模型、预算或安装权限时，集中列出最小请求；不擅自消费，也不删除真实验收要求。以上未完成前，不建议把主要精力转去 Door、多模型池、大规模自我升级。

## 七、给下一位开发 Agent

本报告是审核意见，不是扩大授权或发版许可。可以质疑修复建议，但必须给出更可靠的实现与等价行为证据；不要只针对测试里的字符串打补丁。

保留现有历史记录与原始失败证据，只新增迁移。不得用全自动 confirmed、关闭全部记忆、删除冲突、移除批准或允许所有工具来“修绿”。

本轮开始时已有删除标记 `apps/desktop/e2e/.playwright-out/.last-run.json`，本审核未恢复或改动它；新增测试清理仅涉及自身创建并校验路径的临时目录。

最终交付分开写：代码已实现、隔离自动化通过、真实环境通过、用户接受、仍未完成。核心问题始终是：**你是否更省心地被理解、得到有用建议，并在授权范围内让事情实际完成。**

