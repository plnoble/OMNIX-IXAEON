# IXAEON V0.3 重整独立审核（2026-09-13）

审核基线：`47e1f8e`。接手时工作区干净。桌面包 `0.2.8`，根 package.json 仍为 `0.2.6`，迁移截至 20。

## 1. 结论先说

**本轮不通过“重整完成／V0.3 整体验收”。可以确认组件接入有实质进展，但仍是有重要安全与产品缺口的集成试用版。**

这次不是只有页面和空壳：已有真实 Hermes 回合、搜索服务配置、真实 Codex 文件任务的开发记录，旧审核用例也确实转绿。问题是这些组件还没有成为受 Core 统一控制、从日常入口连续工作的个人 Agent。

用通俗的话说：发动机装上了，也试着开动过；但记忆、研究、权限和验收仍有几套各自工作的线路。不能把分别通电当成整车验收通过。

最重要的修复顺序：

1. 先收住工具审批、外发权限、撤权、取消和执行／验证范围。
2. 再从同一个桌面对话入口，把 Core 记忆、真实研究、任务批准和产物检查接成连续过程。
3. 用这条生产路径重新评测记忆与成长，不再用专门喂好材料的评测替代产品验收。
4. 最后补发布门禁、安装恢复和较大规模数据测试。

本轮只增加独立审核报告、测试和证据；没有修改业务代码、运行中的配置、日用数据库或安装包，没有提交、推送、部署，也没有调用真实付费模型／搜索／Codex。

## 2. 本轮实际做了什么

阅读了 AGENTS、长期路线、架构决策、重整计划、上轮独立审核、最新交付与开发日志；检查重整后的生产调用路径、协议、资料访问、执行验证、研究调度和评测代码。

| 检查                             | 本轮结果                         | 能说明什么                                                        |
| -------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| 离线 unit + integration          | 256 通过，10 跳过                | 既有离线回归有价值；真实环境探针明确关闭                          |
| 2026-09-11 独立审核回归          | 20/20 通过                       | 上轮所列复现场景已修复，不应否定这些进展                          |
| 新增最终独立检查                 | 15 项：2 对照通过、13 未满足断言 | 定向验证下文缺口；不是产品随机失败率                              |
| TypeScript                       | 通过，exit 0                     | 当前生产源码类型检查通过                                          |
| ESLint                           | 19 错误，exit 1                  | 默认 verify 在第一步就会失败                                      |
| 发布范围 Prettier 检查           | 4 文件不符合，exit 1             | 即使修完 lint，格式门禁仍未过                                     |
| 真模型／真搜索／真实编码／安装器 | 本轮未复跑                       | 既有记录与用户接受保留，但不冒称本轮亲自再验通过                  |
| Electron 真实 UI 全链路          | 本轮未复跑                       | 桌面调用边界用合成依赖调用实际 AppRuntime.ask；不等于真人 UI 验收 |

离线集成排除了 `memory-eval-rescore.test.ts`：该测试默认会改写仓库里已有 corrected 评分结果。本轮保留历史证据，不让复跑顺手改写它们。关闭了真实模型、搜索、网络、Codex、日用库探针，并在测试进程清空 Hermes 定位变量，避免本机已安装引擎被离线测试意外启动。

初始沙箱辅助进程无法初始化；只读检查和经检查的合成测试通过获准的沙箱外命令执行。测试产生的文件仅在本次唯一临时目录，清理前校验了父目录和前缀。没有针对真实资料执行删除或越权实验。

证据：

- [最终独立复现结果](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-restructure-20260913-final-budget-checked.json)
- [独立测试源码](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/restructure-20260913.test.ts)
- [离线基线结果](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-restructure-20260913-baseline.json)
- [上轮审核复跑结果](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-direction-quality-20260913-rechecked.json)

### 证据修订说明

首轮 `results-restructure-20260913-independent.json` 原样保留，但不是最终结论：E01 测试误用了不存在的 `projects.update`，已改用真实 `rebindRoot`；原 M02 混淆了撤销原文授权与保留派生结论，改成只验证原文撤权的 C02 对照；原 E02 的 `--no-permission` 尝试未形成越界，不算漏洞证据，随后改测显式提供更宽的 permission 参数。第二轮另存 `-checked.json`，加入评分器反例后最终另存 `-final.json`。没有把测试自身错误当产品缺陷，也没有覆盖首轮结果。

最终又为 R01 补齐显式的一次搜索预算前提，另存 `-final-budget-checked.json`，仍为 13 项未满足断言、2 项对照通过；旧 `-final.json` 保留，不以“未授权付费应被禁止”制造失败。

## 3. 必须修改的问题

### A01 · P1：工具白名单、次数上限和取消没有成为实际执行边界

位置：[审批与事件处理](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/tuiGateway.ts:234)，[能力探测](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/adapter.ts:77)。

已复现 H01–H05，均为离线协议帧，不声称攻击过真实 Hermes：

- 只允许 `search_memory` 时，终端命令文本仅仅包含这个词，审批就返回 `once`，而不是拒绝。原因是对 description/command 等文本做 `hay.includes(toolName)`。
- 收到不在本轮 allowedTools 中的 `record_observation`，仍写入 Core。
- 同一个 tool_id 的通知重复到达，会写入两条记录。
- interrupt 后晚到的 tool.start 仍写入记录。
- maxToolCalls=1，实际可写 3 次。

这是“界面说受控，执行入口却没有强制执行规则”。不能靠提示词提醒模型自觉遵守。

修改要求：

1. 用可信协议字段与服务端工具注册表精确识别工具；命令说明和网页文本不提供批准权。编码执行必须绑定真实用户批准或有效预授权。
2. 每次真正的工具调用之前检查身份、权限代次、状态、次数／预算；callId 幂等；终态之后拒绝新副作用。
3. tool.start 是通知，不应直接当作另一份执行命令。实际执行和结果返回应统一经受控 MCP／工具入口，避免同一动作在 Hermes 与 Core 各执行一次。
4. 取消应停止子进程树并等待停止；当前网关 dispose 只调用 child.kill，尚不能证明子工具树已结束。
5. capability 不得因找到 python.exe 就把 session/stop/toolAllowlist 填 true。真实探测与降级状态分开。

### A02 · P1：个人条目过滤了，但对应原文从另一个通道漏给模型

位置：[Core search_memory](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/broker.ts:53)。

已复现 M01：导入仅获准本地读取的合成个人资料，没有 model 分享。工具的 items 做了 modelMayReadItem 过滤，但 segments 直接返回，仍包含整段私密标记。

这是“卡片锁了，卡片背后的原文没锁”。本轮只验证工具返回包含内容，没有向真实云模型发送私人数据。

修改要求：统一按受众检查结论、原文、前后文、项目背景、检索索引和缓存；不能只对 items 检查。本地读取授权不等于云端外发授权。补充“尚未提取成条目的原文”和“一个片段关联多种范围”的测试，不能依靠是否已生成个人卡片决定隐私。

保留旧政策的明确区别：撤销原文授权不自动删除所有派生结论。本轮 C02 证明原文撤权过滤本身仍有效；该语义不应被修复误伤。

### A03 · P1：撤销问答存档后，下一次提问会自动重新授权

位置：[桌面问答存档](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:664)。

已复现 M03，调用实际 AppRuntime.ask，只有模型／网络依赖为替身：

首次提问生成 ask.ixaeon.local 授权 → 撤销 → 再次提问 → 代码再次调用 grantDomain，生成新的 active 授权并继续存档。

现有 ask-capture 测试只直接把“已撤销的 permissionId”传给底层 captureAsk，没覆盖上层自动重新 grant 的行为，因此三个用例绿不代表桌面撤权有效。

修改要求：保存独立的“问答存档启用／暂停／撤销”状态；普通提问不得隐式 grant。首次授权、用户明确恢复与正常记录必须是不同入口。撤销后重进页面、重启、再次提问都应保持停止存档／提取；旧记录可保留，但不可借新授权绕过旧选择。

用户曾要求“所有问答都进 Core”，并不意味着后来撤销永远无效。

### A04 · P1：独立验证器仍可扩大自己的文件权限

位置：[defaultCheck](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/execution/executor.ts:635)。

已复现 E02：验证 argv 自带 `--permission` 和指向工作区外的 `--allow-fs-write` 时，代码不再添加工作区限制。测试成功在工作区外写出无害标记；该位置仍属于本轮独立测试临时目录，不涉及真实文件。

静态检查还发现：非 Node 可执行程序不走这一权限加固。批准一条“验证命令”不应隐含允许它继承主机任意文件和执行能力。

修改要求：

- 验证命令必须经过统一沙箱执行，不因命令自带 permission 参数就认为安全。
- 拒绝／规范化冲突及扩大权限的参数；未知可执行程序不能直接裸跑。
- 对 Node 测试、npm、Python 等所需能力明确支持或明确不支持，不能靠教用户换一个命令绕开保护。
- 验证阶段纳入任务取消和超时；当前使用独立的新 AbortController，用户取消没有传入正在运行的验证程序。
- 补工作区外读写、子进程、参数覆盖、取消期间继续运行等反例。

### A05 · P1：范围核验漏掉删除，也没核验验证程序产生的改动

位置：[diffWorkspace](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/execution/executor.ts:693)，[执行与验证顺序](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/execution/executor.ts:465)。

已复现：

- E01：只批准 note.txt，执行器删除原有 keep.txt，再写 note.txt，且自报 changedPaths=[]。任务仍进入 pending_accept。原因是 diff 只遍历 after，删除项根本不在其中。
- E03：执行器只写 note.txt，但验证程序另写 outside-approved-scope.txt；任务同样进入 pending_accept。因为范围检查只在验证前做。

修改要求：比较新增／修改／删除三类变化，处理符号链接和路径解析；验证前后都检查，或让验证环境对产品树只读、临时输出另有明确范围。用户接受前重新绑定最终产物指纹和验证证据；不能接受一份验证后已变动的工作区。

### A06 · P1／阶段阻断：Hermes 还没有真正成为“由 Core 管理的发动机”

位置：[AgentSession](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/session.ts:78)，[网关提交](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/tuiGateway.ts:100)，[MCP 工具注册](D:/Agent/Project/OMNIX-IXAEON析衍/apps/mcp/src/shared.ts:148)。

静态证据与已有交付记录一致：

- 桌面 Hermes 路径主要发送用户问题和一句“请用 record_observation”的约定；contextRef、permissionVersion 和 budget 并未转换成引擎的上下文／权限配置。
- 当前 MCP 注册仍是 prepare_task、search_context、get_source_excerpt、record_work_result 四个旧工具；并没有把新 Core Broker 的记忆写入、搜索、草案等工具完整注册给 Hermes。
- 本地 broker 在 tool.start 通知中执行，结果仅记入本地事件，未作为该工具的实际响应交回引擎。不是“函数存在就已经接上”。
- 代码没有强制关闭 Hermes 独立长期记忆和无约束内置工具。开发日志甚至已记录真人日程被写进 Hermes 自带 memory，随后仅增加了提示词约定。
- 每次 Ask 创建新的 session，只发送本次问题；界面也只显示本次问答。没有实现可连续聊天的会话历史装配，问“那我刚才说的呢”不能依靠同会话背景获得保证。
- 正常 Hermes 路径的运行账本在结束后才插入；断电／崩溃前的实际动作缺少持续记录。失败 catch 后另走 Core 循环，原始 Hermes 错误和可能已完成的副作用没有可靠接续依据。

因此 B1 的“真模型回合”“合成库 MCP 探针”“单独 Codex 探针”分别成立，不等于桌面对话 → Core → 真实搜索 → Codex → 独立核验这条路径已完成。现有 B1 绿星应改成组件已验证、整条路径未完成。

修改要求：落实真正的 Core 工具服务和会话身份，将每次调用结果交回引擎；内置记忆／工具明确关闭或桥接；专属配置、授权版本、持久事件与恢复统一管理。从桌面跑同一个完整任务验证，不再分别拼三份探针报告。若保留自研兜底循环，需补 ADR，明确职责与切换限制，而不是悄悄形成第二套主 Agent。

### A07 · P1／产品验收阻断：记忆评测不等于生产路径，且评分器会把缺证据算通过

位置：[评测预组装材料](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/memory-eval-real.test.ts:120)，[问句回声评分](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/memory-eval-rescore.test.ts:51)，[Inbox 查询](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Inbox.tsx:15)。

两个问题不能混为“模型偶尔答错”：

1. 评测用 loadModelVisibleItems + selectRelevantItems 先喂好材料，再发给 Hermes；生产 AppRuntime.ask → AgentSession → TuiGateway 并不调用这条选材流程。Core 兜底也用 broker 的另一种检索。因此三轮高分不能证明桌面产品的自动记忆质量。
2. 已复现 Q01：直接运行仓库现有纯评分函数，r6“编码任务的约束是什么？”收到空回答，missingRecall 仍为空。因为问题包含唯一评分词“编码任务”，该必答事实被从评分清单中整个删掉。这个场景也没有其他命中项，按现有 correctedPassed 规则会算通过。

避免问句回声误报是合理的，但不能因此把“没有证据”改成“正确召回”。本轮没有据此重算并覆盖历史高分。

日常形态也未充分改变：

- Inbox 仍按 needsReview=true 查询普通条目；主要是文案改成“不必逐条确认”。Ask 又明确提示“理解候选在待讨论等你确认”。总览过滤有所改善，但整体流程还不一致。
- 一次性要求主要靠十几个正则词降格为 open_loop，不是完整的事件／适用范围模型；普通 PPT 指令和“去年会议”不会因为数据库换成向量库就自动理解正确。
- LanceDB 当前只是无论是否给路径都返回关键词降级的骨架，不是“仅缺用户配置嵌入模型就可运行”。

修改要求：把上下文选择做成生产和评测共用的实际服务；从导入／新会话／纠正／撤权／重启跑到回答。补空回答、否认事实、照抄问题、执行失败等评分器反例；不可评分记为不可评分，不得计入通过。调整样本和评分要保留旧结果，固定新的未调参验收集，再跑三轮。普通自动理解与真正待用户决定事项分开，不能靠换文案完成。

### A08 · P2／阶段阻断：研究仍是人工搜索与来源订阅，不是主动研究

位置：[研究循环](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/research/checker.ts:142)，[网页读取限制](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/broker.ts:155)。

已复现 R01：合成主题已启用，并预设 request_cap=1 的一次搜索预算，搜索执行器可用，定时 tick 仍不调用搜索；无既有网址时失败。没有要求在预算为 none 时擅自付费；代码明确只在手动检查搜索。

其他静态缺口：搜索词直接取用户写的 public_description；候选必须逐 URL 人工批准；check 循环没有模型研读、比较和目标价值判断；找到条目就落发现／通知。研究问题不是研究推理的输入，paid_budget_mode 也尚未接入实际搜索次数。

数据库外键要求 finding 指向 source，是数据设计约束，不是必须让用户逐个批准网址的产品理由。可以在已批准领域、预算和公开网络边界内自动建立来源记录。

修改要求：首次启用批准领域、可外发范围、预算、通知；此后 Agent 自主查询、选择公开来源、研读和判断。无变化安静，有失败如实报错。暂停后停止后续请求／写入。先接通一个真实方向，不必同时做许多供应商。

用户要求提供 Brave/Tavily Key 输入方式不等于批准取消自动研究。当前日志所说“用户再点一次立即检查就闭合”，仅能证明手动链路，不能当 B3 完成条件。

### A09 · P2／阶段阻断：Skill 目前是状态表，不是经过验证的方法成长

位置：[SkillCandidateStore](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/runtime/skills.ts:90)，[所谓真实对照探针](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/test/integration/b4-real-project-codex.test.ts:148)。

已复现 S01：evalBefore 和 evalAfter 都为空，只写 benefit='improved'，就可以 approve。

当前 evaluate 只是存三段文字；没有强制绑定评测执行、用例／模型／方法版本、产物与真实分数。method 在创建时是固定占位文案，缺少实际候选方法编辑／生成路径；桌面 IPC 没有 Skill 评测批准／回退入口。所谓真实对照探针把之前开发者修复的现象写进字符串，并未让产品自己产生和比较新方法。

修改要求：固定一个小失败案例，用真实候选方法执行前后对照，保存不可由候选改写的证据；用户从真实入口批准具体版本，下次任务确实使用，再可撤回。无证据、无收益不能批准。先完成一个低风险方法，不要求立刻接大规模自进化框架。

B4 的真实小文件任务与用户接受可以保留为进展；不能因此把“经验成长”也一起标绿。

### A10 · P2：发布验证口径需要修正，当前默认 verify 无法通过

本轮 TypeScript 通过，但 ESLint 19 错误；包括实际生产文件 appRuntime、shared、broker、session、tuiGateway 等。Prettier 不符合的 4 个文件：

- apps/desktop/src/preload/index.ts
- apps/desktop/src/renderer/src/pages/Settings.tsx
- packages/core/src/research/webSearch.ts
- packages/core/src/storage/retrieval.ts

默认 scripts/verify.mjs 先执行 lint，再检查格式，因此不能宣称完整 verify 已通过。本轮没有启动剩余 build／UI 步骤，也没有把未运行写成失败。

此外，2026-09-11 的独立审核回归尚未加入默认 verify；新重整的真实 UI 行为也缺少对应默认验证。REVIEW_PACKET §40 已出现不可读乱码，部分能力清单仍写“未安装／未配置”，需保留历史并追加当前事实，避免接手者误判。

修改要求：修复门禁并逐步跑完整离线 verify；真实额度测试维持显式授权。将本轮反例纳入独立回归，证据使用新目录／新文件，不覆盖原失败材料。

## 4. 关于方向：我赞成什么，反对什么

赞成：

- 保留自有 Core，复用 Hermes，不推倒来源、纠正和工作记录基础。
- 让真实 Codex 做受控小任务，保留独立验证失败与真人接受的区分。
- 四平台导入先按公开格式开发，缺实际账号样本如实说明。这是开发日志记录的用户新选择，本轮不强求用户提供不存在的 Gemini/Grok/Claude 历史。
- 不为了赶进度宣称 LanceDB、真实安装或软件自升级已经完成。

需要纠正：

- “所有问答保存”只解决档案入口，不等于已经理解用户，更不等于仍需逐句人工确认。
- “提示 Hermes 不用自己的 memory”不是资产独立的实现。
- “手动搜索＋候选网址批准”可以是临时能力，但不能重新定义为主动研究完成。
- “多跑一个循环、存一个技能表”不能代替统一 Runtime 接入与真实成长。
- 不能用缺少用户再点一次按钮解释本来还没有实现的整条行为。

**建议继续当前重整方向，但先修接线与边界，暂不增加新的大模块或继续包装更多管理页。不是把愿景缩小，而是让这一步真正承载后面的愿景。**

## 5. 对 B0–B5 的重新定位

| 阶段               | 本轮判断                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| B0 可信基线        | 旧审核 20/20 已过；新增 Runtime／验证路径仍有 P1，不能算安全基线完成           |
| B1 首条 Agent 路径 | 组件真实探针有进展；同一个桌面任务完整串联、Core 强制工具边界未验收            |
| B2 自动记忆        | 有存档、部分过滤与评测基础；生产／评测分叉、自动理解与索引仍欠实现             |
| B3 主动研究        | 搜索服务接通记录可保留；目前仍以手動候选／批准来源检查为主                     |
| B4 项目行动与成长  | 首个真实小工具任务和用户接受有记录；范围保护仍有漏洞，成长未闭合               |
| B5 覆盖与交付      | 三平台合成导入测试、旧库副本记录可保留；不等于三平台真实兼容和安装／恢复全通过 |

后续验收先要求 A01–A05 的反例转绿，且不破坏本轮两个正向对照和上轮 20 项；再验 A06–A09 的真实桌面行为。A10 是交付门禁，可穿插修复。

完整通过前，建议仅在合成数据／明确获准的小范围试用中继续。不要扩大到全部私人聊天、无人值守编码、长期付费研究或自动升级生产环境。是否暂停当前日用版本由用户决定，本轮未擅自替换或停用软件。

## 6. 开发 Agent 的复现与交付要求

独立复现（不需要真实账户或 Key）：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.restructure-20260913.config.ts --reporter=json --outputFile=apps/desktop/test/review/results-restructure-20260913-fixed.json
```

当前应复现 13 个未满足断言、2 个对照通过。修复后另存 fixed，不覆盖 final-budget-checked；不删除断言、全部禁用功能、伪造 origin／confirmation 或将失败改成成功。

下一批必须分别提交：

- 修改了什么实际生产入口，解决 A01–A10 哪些条目。
- 确定性回归结果、最终产物、未完成项。
- 哪些仅为协议／服务替身，哪些是实际 Hermes／搜索／Codex。
- 哪些用户授权改变了原计划，以及对应 ADR 和新的验收影响。
- 同一桌面任务从发起到结果的连续证据；不以三个独立探针拼成完整验收。

四平台样本口径已按现有日志记录的用户调整处理；不以旧计划为最高指令。其他重大调整同样可以讨论，但需要新的理由、代价和真实行为证据。
