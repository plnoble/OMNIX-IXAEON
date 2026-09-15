# IXAEON V0.3 重整二次复审 — 2026-09-15

审核基线：`93ecaed`，对比上轮 `04f70a3`。本轮跨 9 月 14 日至 15 日完成。本文是新审核，不覆盖历史报告与失败证据。

## 一、先说结论

**有实质进步，方向不需要推倒重来；但本轮只能接受部分修复，不能验收为“D01–D08 全部闭环”或“重整完成”。**

你要的是一个逐渐理解你、能研究和办事的个人 Agent，不是让你维护资料卡、填写测试结果的管理系统。自有 Core、可替换 Hermes、自动且按情境使用记忆、获准研究与隔离执行，这条架构路线仍然合适。当前主要问题不是模块不够多，而是已有模块之间的真实流程和边界还不完整。

最容易理解的三个反例：

1. 在新建研究时选择预批 5 次搜索，实际保存成“未预批、0 次”。补充预算按钮能工作，但创建入口没有接好。
2. 一个从未执行过的技能，只要提交“以前失败、现在成功”的 JSON，就可以变成已批准技能。把文字换成 JSON，并没有让证据变成真实执行记录。
3. 一个第一次被判为无关的自动发现网页，第二次更新了无关内容，又会被当成值得记录的发现。

这不是要求现在就做完手机、NAS、模型池和自我升级。恰恰相反：先把既定的第一条个人 Agent 办事流程做好，再扩规模。

## 二、这次实际验证了什么

仅新增复审测试、结果与本报告，并在交付记录和开发日志末尾追加审核索引；未修改业务代码、迁移、日用库、授权或已安装应用；未调用真实模型、搜索、Hermes、Codex，未安装或发布。

| 检查范围 | 结果 | 能说明什么 |
| --- | --- | --- |
| 上轮 9 月 14 日独立反例及对照 | 12/12 通过 | 上轮具体反例已转绿 |
| 9 月 13 日历史审核 | 15/15 通过 | 这组历史回归通过 |
| 9 月 11 日历史审核 | 20/20 通过 | 这组历史回归通过 |
| unit + integration，排除会重写历史评分产物的 rescore 测试 | 274 通过、12 跳过、0 失败 | 本次执行范围内的基础回归通过；不是全量真实验收 |
| 本轮新增定向检查 | 3 对照通过、9 检查失败 | 找到了旧反例之外的实际缺口 |
| TypeScript | 退出码 0 | 类型检查通过 |
| ESLint | 退出码 1，1 个错误 | 当前静态门禁未通过 |
| 项目 format:check 等价命令 | 退出码 1，4 个文件 | 当前格式门禁未通过 |

注意：新增 12 项是针对疑点设计的检查，不是随机抽样，不能把 9/12 解释为“软件有 75% 的功能坏了”。生命周期检查部分使用真实入口加观察替身，证明缺少失效调用；不等同于已经观察到真实模型泄露或真实子进程残留。

本轮没有执行完整 verify、Electron 界面端到端、真实旧库升级、安装器流程或新版真实模型评测，也不以历史单项成功替代这些证明。

## 三、已确认修好的部分

- 通用 MCP 的 `getEvidence` 现在按照编码客户端受众检查；只分享给主模型的个人条目不能再从这个入口读出。
- 传入的权限版本变化时，Hermes 适配器会丢弃旧会话；明确撤销单条分享的桌面入口也已接入失效处理。
- direct MCP 的新增证据、观察记录路由已补上，不能再沿用“新增端点都未知”的旧结论。
- 项目兜底不再召回上轮那个一次性会议要求；冲突条目进入提示词时保留争议标识。
- 暂停后晚到搜索结果不会新增来源；相同页面不再重复生成发现。
- 纯文字技能评价不能批准；修改方法会清掉旧评价证据。
- 桌面 ResearchChecker 已实际接入惰性模型提供器，不能再说“生产路径完全没有模型研读”。
- A06 的隔离测试已脱离本机真实 Hermes 安装状态。

这些修复值得保留。问题是修好了这些例子，还不等于上轮每条问题的完整验收范围都完成了。

## 四、本轮需要修复的问题

P1 表示进入更多私人数据、无人值守或宣称阶段完成前应优先解决；P2 表示本阶段可靠性与诚实交付所需修复。以下 S2 编号属于本报告，R01–R09 属于本轮测试文件，不是重整计划中的同名验收编号。

### S2-01 · P1 · 新建研究时，界面选择的预算没有保存

位置：[Research.tsx](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Research.tsx:93)、[IPC 创建入口](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:389)、[ResearchStore](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/researchStore.ts:135)。

R01 通过实际 IPC 注册的处理器创建主题，传入 `paidBudgetMode=request_cap`、`requestCap=5`、`intervalMs=60000`。实际入库是 `paid_budget_mode=none`、`request_cap=0`、`interval_ms=86400000`。

原因：公开接口使用 camelCase，存储读取 snake_case，IPC 原样转发，没有转换。研究问题的公开描述已经兼容两种命名，但这三个字段没有。界面目前没有间隔输入，间隔问题是公开 IPC 契约问题；预算问题直接影响现有界面。

影响：只给方向、不提供网址时，用户以为已授权自动搜索，实际定时流程却不会搜索。这是未执行，不是越权花费。

修复与验收：统一边界转换并校验值；从真实创建入口设置预算，检查保存值、重进页面、重启和一次定时扣减。保留“无预算不自动搜索”。本轮对照证明 `setResearchBudget` 补充入口正常，不应误判为所有预算功能都坏了。

### S2-02 · P1 · 技能仍可用调用方填写的“成功证据”通过批准

位置：[skills.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:119)、[桌面评价入口](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:615)、[运行时转发](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:1263)、[任务页](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Tasks.tsx:246)。

R03 经实际桌面 IPC 提出候选，填写不存在的命令、非法时间字符串，以及调用方自报的前后退出码。没有执行命令，没有真实评测记录，随后批准仍返回 `{ok:true}`。

原因：`evaluateWithEvidence` 只验证传入退出码，随后存 JSON；批准只额外检查 JSON 非空及当前版本。它没有向可信评测执行器核对 run ID、命令实际输出、方法哈希和用例版本。非法时间不是核心漏洞，即使把日期格式校验补上，伪造证据仍然成立。

此外，任务页目前有提出候选、查看、批准和撤回，没有调用 `evaluateSkillWithEvidence` 的前端流程，也没有实际运行对照评测的入口。“录入证据完整交互闭环”的交付声明不成立。

修复方向：用户批准的是系统实际验证过的改进，不是自己填写的证明。由受控评测执行器产出不可由 renderer/model 冒充的记录；绑定候选版本、方法内容、固定用例版本及输出。批准只引用可信记录，不接收任意调用方提供的 exit code 作为证明。

验收：伪造 JSON、挪用其他候选的证据、修改方法后复用、已失败或未运行的评测均不得批准；真实的失败→改进→对照运行→展示差异→批准→下次使用应从桌面跑通。候选方法不能修改评测器或验收答案。既有纯文本拒绝、旧版本拒绝和撤回语义必须保留。

### S2-03 · P1 · 会话失效只接了一部分，过期、纠正和退出仍有缺口

位置：[权限纪元](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/access.ts:9)、[复用判断](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/adapter.ts:127)、[来源撤权](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:300)、[纠正入口](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:344)、[退出](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:1044)。

- R04：合成个人条目的分享自然到期后，`modelMayReadItem` 已拒绝新读取，但 `getDisclosureEpoch` 不变。适配器仍可认为旧会话有效。当前纪元只统计数量与最大授权时间，没有计算有效期，也不是完整的权限/内容版本。
- R05：通过桌面纠正条目，数据库旧条目已被替代，但没有触发运行时上下文失效；纪元也不包含纠正变化。
- R06：来源撤权写入成功，没有立即失效当前会话。下一次新运行可能因权限数量变化而重建，不能据此声称当前正在进行的运行已经停止使用旧原文。
- R09：调用实际 `AppRuntime.stop()` 时关闭数据库，但未清理持有的 Agent 会话。

明确单条分享撤销的对照通过，因此不是“撤权功能全部没做”。也不能承诺撤回已发送给云端的数据；要保证的是后续不继续使用、发送旧上下文。

修复与验收：统一有效权限/上下文版本与会话生命周期，覆盖到期、来源撤权、纠正、切换配置、恢复和退出。优先检查恢复前是否停止旧运行，不能等关库/换库后才清理。用合成秘密进入会话，再撤权或到期，检查后续实际出站上下文；纠正后同会话、跨会话、重启均采用新结论；退出和恢复前应结束相关活动，不再访问旧库。

本轮 R05/R06/R09 是入口与生命周期接线检查，不是实测真实 Hermes 后续输出。开发可采用等价失效机制，但必须以相同行为证据替代，不能只删观察断言。

### S2-04 · P1 · 模型研读已接入，但调用预算与外发说明没有一起接好

位置：[ResearchJudge](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/judge.ts:75)、[逐条研读循环](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:245)、[页面承诺](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Research.tsx:151)。

R08：一个获准 RSS 来源包含 10 条内容，一次定时检查调用模型 10 次。重整计划 §6.3 规定起始上限每轮 8 次模型调用，同时另设模型 token/成本限制；当前循环没有这个守门。测试使用 FakeProvider，不产生真实费用。

搜索次数预算只控制搜索，不控制研读。搜索预算为 none/0 也可能继续调用配置的模型研读已有来源；这件事本身可以是合法产品选择，但必须有独立模型授权和限制，不能让“0 次搜索”被误解成“不会产生模型调用”。

静态确认的说明矛盾：界面仍写“问题本身不会外发”，研读器却将完整 `topic.question` 放入模型请求。使用云提供方时，这就是模型外发内容。界面还保留“定时不消耗搜索额度”的旧说明，与新预算及自动搜索逻辑相矛盾。

修复与验收：展示并分别限制搜索、网页读取和模型调用；重试也扣预算，超额返回已完成部分与缺口。首次启用说明服务、出站内容、次数/token/金额或不可计价限制；区分搜索用公开描述与模型可读取研究问题。未经允许的私密字段不出站。若调整默认上限，记录依据和验收变化；不是为了让 R08 变绿临时换数字。本轮未使用真实私人问题或验证真实外发。

### S2-05 · P2 · 自动发现来源的身份会在首次成功检查后丢失

位置：[来源标记写入与判断](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:195)、[成功后清错](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/researchStore.ts:492)。

R02：研究 Rust，自动搜到明星服装网页。第一轮正确判为无关、没有发现；网页更新成另一条无关娱乐内容后，第二轮生成 1 条发现。

原因：`auto_discovered` 塞在 `last_error`，而成功抓取会把 `last_error` 清空。第二轮就把它当成用户明确指定的来源。旧 C06 为什么通过？因为测试页面没变，新增指纹跳过逻辑提前返回，没有覆盖“内容变了但仍然无关”。

修复与验收：来源身份和错误状态分开持久保存；如需加列，只新增迁移。覆盖页面不变、变了仍无关、变为相关、重新变无关、失败恢复及重启。用户明确指定来源与自动来源的区别应保留，不能靠永远跳过第二轮解决。

### S2-06 · P2 · 模型调用失败仍静默降级，结果看起来成功

位置：[judge.ts 异常回退](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/judge.ts:101)、[checker.ts](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:245)。

R07：配置的模型调用抛错，系统退回关键词判断，研究轮次仍成功且 `run.error=null`。返回结构未说明本轮没有完成模型研读。

回退不是错误本身。问题是用户无法区分“模型读懂后的判断”和“只有关键词/摘录的暂时结果”，也不知道模型服务已经故障。

修复与验收：记录实际判断方式、失败原因、模型用量与降级状态，界面如实展示。允许保留已抓取资料及部分成果，不必把整轮全判失败。若新增专门的降级字段，可据真实契约调整 R07；必须保证错误/降级能被用户观察到，不是简单隐藏。

### S2-07 · P1 · 上轮要求的完整 Agent 办事链，仍不能由这次补丁证明完成

这不是本轮新增范围。它属于上轮 D03/D05/D07 与既定 B1/B2/B4，不能以 C09 路由通过代替整体完成。

静态仍可确认：

- [桌面 Ask](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:753) 明确新增桥接的仍是 `record_observation`、`get_evidence`；[MCP 注册](D:/Agent/Project/OMNIX-IXAEON析衍/apps/mcp/src/shared.ts:167) 没有完整公开 Core 的研究和任务工具。
- [网关的非 MCP 工具分支](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/tuiGateway.ts:343) 把本地 broker 结果写进 IXAEON 事件，不代表通过该分支把结果交还引擎继续思考。实际 MCP 副作用的运行身份、预算、取消与幂等仍需端到端证明，不能用通知分支的检查替代。
- [任务提案](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/broker.ts:190) 仍固定用非空 `note.txt` 作为验证命令，不能作为其他文件/实际项目任务的统一成功标准。批准前拒绝模型派发是正确安全边界，不能为接通链路而删除批准。
- [问答结束文案](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:783) 仍把理解候选引到“待讨论等你确认”；[Inbox](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Inbox.tsx:18) 继续以 `needsReview` 拉取。普通自动理解和真正需要你决定的冲突还没完成产品层面的分流。

判断要克制：历史存在真 Codex 单任务和 Hermes 对话证据，不能说这些工具从来没运行过；但本轮没有新增证据证明它们已从真实桌面对话连成完整链路。

修复与验收：从桌面给一个目标，不手工复制提示词、不逐 URL 批准，Agent 读取获准 Core 资料、搜索并解释价值、提出目标与验证条件；你批准具体编码范围后，真实执行器执行，独立验证器核验，结果回到原任务/对话；再产生可验证的方法候选。先用合成资料和低风险文件范围跑通。普通记忆自动整理，只有重要冲突、真正不确定的决定及扩权才打扰你。

### S2-08 · P2 · 静态门禁和交付声明仍需校正

- ESLint：`packages/core/src/storage/mcpStore.ts:19` 残留未使用的 `modelMayReadItem` 导入。
- 格式检查失败：`Research.tsx`、`checker.ts`、`judge.ts`、根目录 `results-direction-recheck-20260914-fixed.json`。历史证据文件不要为过格式门禁直接重写；可合理排除不可变证据，或另存格式化副本并保留原件。
- [真实记忆评测](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/memory-eval-real.test.ts:128) 仍调用旧 `selectRelevantItems`，不能证明当前生产 `ContextSelector` 与连续会话的真实效果。这是上轮 D08 遗留，并非要求凭空加一个新模块。
- `REVIEW_PACKET.md` §50 和开发日志写的“完整交互闭环”“全面落地”超出了代码和本轮证据；应追加更正，不覆盖旧记录。也应同步仍停留在旧状态的验收映射。

本轮基础回归的 274 通过/12 跳过和开发方的 280 通过采用的范围可能不同，不能仅凭数字差异断言其伪造。确凿的问题是：12 个旧反例通过，不足以推出 D01–D08 的全部行为都完成。

## 五、下一批怎么交付，避免继续只修样例

不建议重新设计整个项目或再加一轮管理页。沿当前计划，完成以下三项交付：

1. **可靠边界**：修 S2-01 至 S2-06 的底层原因；让本轮反例和历史回归通过，补上等价桌面/协议行为测试。统一生命周期、模型预算与证据来源，不继续把状态塞进无关字段。
2. **真实桌面办事**：按 S2-07 跑一条完整链路。明确哪个引擎、哪个服务、哪个工具、实际验证命令、批准范围、实际输出；缺账号或预算时列出最小需求，不改成手工提供网址就算完成。开发方案批准不等于真实调用和发布授权。
3. **真实成长与诚实交付**：用受控执行产生技能对照证据，批准后再验证下次实际使用；让当前记忆评测走生产路径。分别列已实现、隔离测试、真实测试、用户接受、未完成，不再用总测试数量代替产品目标。

不要通过删除“未运行也能批准”的反例、放宽隐私、移除批准、把普通记忆全标 confirmed 来求绿。等价架构替换可以接受，但要给行为证据和代价说明。

本轮结论不是“项目做错了，全部重写”，而是：**底子值得保留，修复有进步；要把“我帮你填卡片”继续变成“我理解你的目标，获准后自己把事情办好，并拿结果证明”。** Door、模型池、持续多平台接入和受控升级仍在长期路线，既不取消，也不以此要求当前一口气全部实现。

## 六、证据与复现

新增独立测试：[direction-round2-93ecaed.test.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/direction-round2-93ecaed.test.ts)

新增独立配置：[vitest.direction-round2-93ecaed.config.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/vitest.direction-round2-93ecaed.config.ts)

原始失败结果：[results-direction-round2-93ecaed-checked.json](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-direction-round2-93ecaed-checked.json)

静态门禁命令、退出码及原始输出：[results-direction-round2-93ecaed-gates.json](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-direction-round2-93ecaed-gates.json)

历史回归复跑结果（本轮新文件，未覆盖旧证据）：

- [基础回归](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-round2-93ecaed-baseline.json)
- [9 月 14 日反例](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-direction-recheck-93ecaed-rechecked.json)
- [9 月 13 日审核](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-restructure-93ecaed-rechecked.json)
- [9 月 11 日审核](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-direction-quality-93ecaed-rechecked.json)

在仓库根目录，用 PowerShell 运行隔离反例；修复后另存新结果，不覆盖上面的 checked 原始证据：

```powershell
$env:IXAEON_REAL_HERMES='0'
$env:IXAEON_REAL_CODEX='0'
$env:IXAEON_REAL_SEARCH='0'
$env:IXAEON_REAL_NET='0'
$env:IXAEON_REAL_DAILY_DB='0'
$env:IXAEON_HERMES_HOME=''
$env:IXAEON_HERMES_EXE=''
$env:HERMES_HOME=''
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.direction-round2-93ecaed.config.ts --reporter=json --outputFile=apps/desktop/test/review/results-direction-round2-93ecaed-fixed.json
```

本轮失败测试退出码 1；新测试的类型检查与定向 ESLint 通过。测试使用临时库及模拟网络/模型，清理只限自己创建并校验路径的临时目录，没有删除用户数据。

审阅环境的普通 shell 启动存在 Windows sandbox helper ACL 故障，本轮 shell 检查通过逐次批准的限定命令执行，没有改系统 ACL。9 月 14 日曾因工具额度中断；9 月 15 日续审后新测试才成功创建并运行，不将中断前未完成的工作记作已完成。
