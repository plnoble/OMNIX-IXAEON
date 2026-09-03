# Jarvis Constitution v0.1

**私人持续进化 AI 系统宪法、思想记录与开发路线**  
版本：v0.1  
日期：2026-09-02  
状态：设计基线  

> 本文档记录 Jarvis 项目的第一版宪法、系统边界、隐私与安全原则、持续进化机制、设备与模型分工，以及从“无限 Token”这一最初设想到当前架构的主要讨论与结论。它既是后续开发的约束文件，也是项目思想演进的档案。

---

# 第一部分：项目愿景与基本定位

## 1. 项目愿景

Jarvis 的目标不是重新训练一个属于个人的 GPT，也不是制作一个把所有功能塞进去的巨大万能软件。

Jarvis 的目标是建立一个：**长期属于用户、不会因为更换模型而失忆、能够持续理解用户、持续学习世界、持续形成专业能力、持续改进自身工具与工作方式的私人 AI 系统。**

Jarvis 最终融合五种身份：

- **Digital Twin / 数字分身**：理解用户的长期目标、项目、习惯、经验和历史。
- **Personal Assistant / 超级个人助手**：成为用户唯一、统一的交互入口。
- **AI Researcher / AI 研究员**：主动研究互联网、论文、GitHub、新模型和新技术。
- **AI CTO / AI 技术总管**：管理开发项目，调用 Codex、Claude Code 等工具完成开发。
- **AI Scientist / AI 科学家**：提出假设、设计实验、运行实验、评估结果并改进自身能力。

核心思想不是“自己训练一个世界最强模型”，而是：

> **拥有属于自己的永久记忆、知识、经验、能力和上下文，同时动态调用当时世界上最合适的模型。**

## 2. Jarvis 不是一个模型

Jarvis 本身不是 GPT、Claude、Hermes、OpenClaw 或任何一个单独模型。

```text
                   JARVIS
                      │
              Jarvis Core
                      │
       ┌──────────────┼──────────────┐
       │              │              │
     Memory        Knowledge       Projects
       │              │              │
 Permissions     Source Registry   Goals
       │              │              │
       └──────────────┼──────────────┘
                      │
                 Model Router
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
     GPT           Claude        Local Models
       │              │              │
     Codex       Claude Code       Workers
```

模型负责思考；Jarvis 负责“我是谁、我做过什么、我为什么这样做、我还有什么没完成、什么资料可以被谁读取、当前该调用什么模型、该研究什么、哪些能力已经验证有效”。

因此 GPT 可以换、Claude 可以换、Hermes 可以换、设备可以换，但 Jarvis 的核心记忆和能力资产不能跟着任何一个外部平台消失。

## 3. 统一大脑，不统一软件

Android Agent、Token 额度监控、知识库、Rokid、AI 短剧、翻译系统等仍然应该保持为独立项目。Jarvis 只负责理解和调度它们：

- 这个项目是什么、为什么开发；
- 代码在哪里、当前是什么版本；
- 做过哪些决定、试过哪些方案；
- 哪些方案失败过；
- 还有什么没有完成；
- 与其他项目有什么关系。

**核心原则：统一大脑，不统一代码库。**

---

# 第二部分：数据、记忆与知识

## 4. 数据所有权

用户的数据正本必须尽可能由用户自己掌握，包括 AI 对话、文件、项目资料、开发历史、Memory、Knowledge、Experience、健康数据、财务上下文、研究资料、Skills 与 Evals。

## 5. 原始资料优先永久保留

```text
ChatGPT 原始聊天
        ↓
AI 对聊天的理解
```

二者必须同时保留。AI 的理解可以错，原始资料不能因为 AI 已经总结过就删除。未来模型更强时，可以重新解释原始资料。

## 6. Source、Knowledge、Memory、Experience 必须分开

- **Source**：原始证据，如聊天、PDF、Excel、Markdown、网页、Git Commit、日志、录音。
- **Knowledge**：Jarvis 当前认为世界是什么样。
- **Memory**：与用户本人和项目长期相关的信息、偏好、规则和上下文。
- **Experience**：真正执行过任务后留下的过程、结果、错误和经验。

四者不得混为一谈。

## 7. 知识可以改变，历史不能被抹掉

```text
RAW SOURCE
永久保留

CURRENT KNOWLEDGE
当前推荐结论

HISTORICAL KNOWLEDGE
过去结论
```

旧知识不是直接删除，而是降权并保留来源、时间和当时依据。

## 8. Memory 必须有可信度与生命周期

Memory 不应该因为 AI 一次猜测就成为永久事实。建议区分：

- Candidate Memory：AI 推断，尚待验证；
- Confirmed Memory：有多次证据支持；
- Trusted Memory：用户明确要求长期记住或明确确认。

Memory 应支持 `confidence`、`created_at`、`last_used`、`last_confirmed`、`superseded_by` 等信息。

## 9. Conversation Import 是第一批核心数据

第一批资料建议包括：

- ChatGPT Export；
- Claude Export；
- 其他 Agent/平台可导出的原始聊天；
- Custom Instructions；
- 重要 Markdown 与项目文档。

导入后不是只做聊天摘要，而是提取 Projects、Decisions、Memories、Goals、Open Loops、Experiences 与 Relationships。

---

# 第三部分：隐私、权限与安全

## 10. 隐私是最高级约束之一

Jarvis 的目标不是监视用户。必须采用**领域分仓 + 主动授权 + 最小权限**。

建议至少分为：Health Vault、Finance Vault、Work Vault、Personal Vault、Development Vault。

## 11. 不同 Specialist 只获得必要权限

Health Specialist 默认不获得财务资料；Finance Specialist 默认不获得健康资料；开发 Agent 默认不获得私人聊天与 Secret Vault。

Jarvis 可以知道“某类资料存在”，但不代表所有 Agent 都能读取其内容。

## 12. 信息获取必须主动授权或遵守明确规则

### 连续健康数据

血压、血氧、心率、体温、睡眠等可以本地持续监测：一次异常记录，多次异常提醒，持续趋势异常才触发进一步分析。

### 年度体检报告

默认保存但不主动深度分析，用户明确要求后才启动。

### 微信聊天

默认不读取。用户主动选择某段聊天交给 Jarvis 后才允许进入当前任务上下文。

### 财务数据

允许知道持仓、成本、组合结构、重大风险和相关新闻；默认禁止自动买入、卖出、转账或执行其他金融交易。

> **Read + Analyze + Alert ≠ Execute**

## 13. 隐私等级

- **P0 — Public**：公开资料，可使用云端模型。
- **P1 — Personal**：一般私人资料，必要时可上云。
- **P2 — Sensitive**：内部工作、财务等，优先本地处理或脱敏。
- **P3 — Highly Sensitive**：健康原件等，默认不得直接上传云端。
- **P4 — Secret**：密码、API Key、SSH Key、Token 等，禁止进入普通 Memory，必须进入独立 Secret Vault。

## 14. 云模型不能默认获得全部资料

```text
100GB 本地数据
        ↓
本地搜索
        ↓
召回相关内容
        ↓
权限判断
        ↓
隐私过滤
        ↓
必要时脱敏
        ↓
只发送必要 Context
        ↓
强模型
```

核心原则：**数据尽可能留在本地，强智力按需调用。**

## 15. 外部能力默认不可信

任何 GitHub 项目、外部 Skill、Gene、Capsule、MCP Server、Plugin、Agent、Model、Script、Container 或 Prompt Package 进入 Jarvis 时默认状态均为：

**UNTRUSTED**

Star 很多、平台知名、其他 Agent 推荐，都不能自动获得信任。

## 16. 外部能力必须经过 Quarantine

```text
Internet
↓
External Skill / Gene / MCP / Code
↓
QUARANTINE
↓
来源检查
↓
静态扫描
↓
依赖与权限分析
↓
网络行为检查
↓
Sandbox 运行
↓
假数据测试
↓
安全 Eval
↓
能力 Eval
↓
Candidate
```

禁止“下载后直接运行”。

## 17. 外部能力必须采用最小权限

例如一个“视频 Prompt 检查 Skill”原则上只能读取自己的沙盒目录，不应该读取全部 NAS、健康资料、SSH Key、浏览器 Cookie 或 Secret Vault。

## 18. 危险 Skill 必须先用假数据测试

测试环境优先使用 Fake Memory、Fake NAS、Fake Credentials、Synthetic Data。确认行为与网络活动后，才允许处理真实资料。

## 19. 默认只从外部网络吸收，不自动向外分享私人能力

连接 EvoMap 或未来其他 Agent Network 时，可以下载公开 Candidate Gene 并在本地验证；Jarvis 的 Memory、健康、财务、工作与个人资料默认不得自动向外发布。

---

# 第四部分：专员、领域与知识来源

## 20. 用户只面对一个 Jarvis，后台可以有很多 Specialist

```text
Jarvis
│
├─ Health Specialist
├─ Finance Specialist
├─ Development Specialist
├─ AI Short Drama Specialist
├─ Research Specialist
└─ Travel Specialist
```

普通问题调用一个合适的 Specialist；复杂问题可以召开 Roundtable；最终结果由 Jarvis 统一呈现。

## 21. Specialist 不是人格扮演

不能仅靠“你是一名世界顶级医生”建立专业能力。一个真正的 Specialist 应由：

**专业模型 + 可信专业资源 + 用户授权数据 + 专业工具 + 领域经验 + Eval** 组成。

## 22. 专业领域动态生长，不提前建设全部领域

例如用户突然开始研究 AI 短剧：

```text
Domain: AI Short Drama
Maturity: 0 / 100
Status: Exploration
```

Jarvis 可以逐步建立剧本、分镜、角色一致性、场景连续性、视频模型、配音、Lip Sync、剪辑、成本、商业模式等知识和实验体系。

专员是“长出来的”，不是预先写死一百个角色。

## 23. Source Registry 不是“下载全世界所有资料”

Jarvis 不需要提前下载全世界的医学书、金融书或技术资料。每个领域更重要的是拥有一张“去哪里找可靠答案”的知识地图。

例如健康领域可以知道：临床指南、官方机构、医学数据库、专业医学模型、最新论文分别解决什么问题。

## 24. Source Registry 必须自己升级

每个来源应具有 Authority、Accuracy、Freshness、Relevance、Signal/Noise、Originality、History 等评分。

Jarvis 可以：

- 发现新的高质量来源；
- 提升多次提供高价值信息的来源权重；
- 降低长期停更、错误率高或噪声过大的来源；
- 让新来源先进入观察名单，再逐渐晋升为可信来源。

---

# 第五部分：目标、自主性与主动学习

## 25. Jarvis 应主动学习互联网

Jarvis 可以主动扫描 GitHub、官方文档、论文、模型发布、技术新闻和公开研究社区，但不是“什么都学”。

面对新信息应先问：

- 以前知道吗？
- 与用户目标有关吗？
- 会改变已有结论吗？
- 能解决当前项目问题吗？
- 值得投入多少计算资源？

## 26. 目标分为三层

- **Level 1 — 长期目标**：如建立私人 Jarvis、掌握 AI 新技术、提升工作效率。
- **Level 2 — Project Goal**：如 Android Agent、AI 短剧、Jarvis Memory。
- **Level 3 — Current Problem**：如 Android 后台存活、NAS 检索准确率、Memory 召回不足。

Jarvis 的自主学习必须服务于目标体系。

## 27. Jarvis 允许并鼓励主动创造新目标

Jarvis 可以根据长期模式主动提出 Proposed Goal，例如发现跨设备调度需求反复出现，建议建立 Device Registry。

必须区分：**Proposed Goal ≠ Approved Goal**。

## 28. Jarvis 可以提交每周工作计划

建议每周生成 Next Week Proposal，列出优先级、研究目标、预计 Token/算力消耗、理由和预期收益。用户可以批准、延后、增加、删除或调整预算。

核心原则：**用户负责战略，Jarvis 负责授权范围内的战术。**

## 29. 自主等级允许达到 D

- A：只告诉用户发现了什么。
- B：自动研究并提交报告。
- C：自动研究并运行实验。
- **D：自动研究、实验、生成代码、创建候选 Branch、完成测试。**
- E：未经批准直接部署生产。

当前目标允许 D，默认不允许 E。

## 30. 云端成本、高风险动作必须有审批门槛

本地模型和闲置设备可以在规则内低成本探索；云 API、敏感资料、生产部署、外部写操作等必须根据预算和风险策略决定是否需要用户批准。

---

# 第六部分：持续进化

## 31. Jarvis 需要进化，但不是每天重训大模型

真正应该持续进化的是：Skill、Prompt、Tool、Retrieval、Memory Rule、Model Router、Research Process、Source Registry 和工作流。

## 32. 受控自我进化

禁止正在运行的 Jarvis 直接修改自己的生产代码。

```text
发现问题
↓
创建 Improvement
↓
开发 Candidate
↓
Sandbox
↓
Test
↓
Eval
↓
Review
↓
Git 版本
↓
部署
```

## 33. Jarvis 必须监控自己

Jarvis 需要 Observability，包括 Logs、Metrics、Traces、Errors、Health Checks、任务失败率、数据库状态、NAS Indexer、Agent Runtime、模型调用和 Worker 状态。

真实故障应该自动形成 Incident，而不是等用户发现。

## 34. 自我进化必须以真实问题和 Eval 为依据

不能因为 AI “觉得新版更聪明”就升级。旧版和新版必须在同一套 Eval 上比较，并进行回归测试。

## 35. 每一次失败都应该成为 Eval

> **Every failure should become an eval.**

用户纠正过的问题、生产故障和失败方案应转化为以后版本必须通过的测试。

## 36. 每一种重复成功都应该成为 Skill

> **Every repeated success should become a skill.**

经验连续多次成功后，应提炼成版本化 Skill，而不是每次重新从聊天历史里临时总结。

## 37. 引入 Gene / Capsule / Event 思想

借鉴 EvoMap：

- **Gene**：可重复使用的方法或策略；
- **Capsule**：一次经过验证的成功案例；
- **Event**：发生过什么、采取了什么行动、结果如何。

这些能力资产必须可追溯、可验证、可降级、可回滚。

## 38. 可以继承外部 Agent 的经验，但必须本地验证

外部 Gene/Skill 只能作为 Candidate。经过安全隔离、权限审计和本地 Eval 后，才能成为 Jarvis 自己的 Skill。

## 39. Curiosity Engine

Jarvis 应持续询问：什么发生了变化？我还不知道什么？什么与用户目标相关？哪些问题一直失败？哪些新技术值得学习？哪个能力最值得投入算力？

## 40. Auto Research Loop

```text
Discover
↓
Question
↓
Research
↓
Hypothesis
↓
Experiment
↓
Evaluate
↓
Learn
↓
Update
```

这是真正可以持续投入 Token 和算力的核心循环。

## 41. Roundtable / Swarm 只用于高价值复杂任务

普通问题无需多 Agent。复杂研究、跨领域判断或需要相互挑错的任务，可以使用多 Specialist Roundtable 或 Swarm。

---

# 第七部分：模型、额度与算力调度

## 42. Model Router 是 Jarvis 核心模块

每个任务应综合判断：难度、隐私、成本、是否 Coding、是否联网、速度、设备状态、额度和专业领域。

例如：简单分类 → 本地小模型；高难研究 → 强云模型；Coding → Codex；Code Review → Claude 或其他合适模型；医学资料 → 医学模型 + 专业来源 + 强模型综合。

## 43. 本地小模型不是 Jarvis 智商上限

本地模型更适合分类、Embedding、初筛、脱敏、元数据提取、简单摘要、隐私任务和大批量处理。复杂推理再交给更强模型。

## 44. Compute Economy

Jarvis 必须理解不同资源的真实成本：Codex/Claude Coding Plan 的额度窗口、云 API 的金钱成本、4080/未来 GPU Server 的电费、本地手机与 Steam Deck 的闲置算力。

## 45. 不追求把 Token 强行烧完

“无限 Token”不是目标，真正目标是最大化 **Information Gain / Capability Gain**。当继续研究带来的新信息趋近于零，就应停止。

## 46. AI Worker Pool

未来红魔、Steam Deck、旧 PC、4080、旧 NAS、未来双 5090 AI Server、云模型都可以注册成独立 Worker。

这些设备不是把显存简单相加成为一个大模型，而是组成一个 AI 工人池，分别承担适合自己的任务。

## 47. Worker 必须声明能力和状态

例如设备、模型、RAM/VRAM、在线状态、电池、是否充电、温度、速度、隐私级别、当前负载、支持的任务类型。

## 48. 移动 Worker 不能承担关键基础设施

红魔等设备可能断网、没电、被带走、温度高或后台被杀，因此定位为 Opportunistic Worker，而不是核心数据库或关键调度节点。

---

# 第八部分：设备与基础设施分工

## 49. Jarvis Server、NAS、AI Server 职责分离

### Jarvis Server

24 小时在线控制中心：Jarvis Core、Memory、Search、Scheduler、Model Router、API、MCP、Agent Runtime。

### NAS

长期档案馆：原始文件、聊天、录音、图片、项目资料、数据库备份、历史快照。

### AI Server

重型算力实验室：大本地模型、视频生成、大量 Eval、Fine-tuning、Agent Farm、大型批处理。

## 50. 工作数据库优先放 Jarvis Server 的 NVMe

不建议把高频工作的数据库直接放 NAS 网络共享。推荐 Jarvis Server NVMe 保存当前数据库和索引，NAS 负责原始档案和快照备份。

## 51. NAS 新资料可以自动索引，但不默认修改原目录

Jarvis 可以监控指定目录，新文件出现后读取 Metadata、解析内容、分类、打标签并建立索引；原文件结构默认保持不变。

## 52. 文件检索先使用索引，再让模型判断

例如“找上周那份 Staccato 春季订单”，优先使用时间、文件名、全文、项目、品牌和语义检索找到候选，再让模型进行最终判断。

## 53. 第一阶段不要求一次性购齐设备

优先使用现有开发笔记本、NAS 和 RTX 4080 PC。Jarvis Core v0.1 稳定后，再考虑 MS-A2 作为第一台正式 24 小时 Jarvis Server。

---

# 第九部分：Agent Runtime、MCP/API 与开发闭环

## 54. Agent Runtime 必须可替换

Hermes、OpenClaw 等只能作为 Agent Runtime，不能成为 Jarvis Core 的根。

```text
Jarvis Core
     ↓
Agent Adapter
     ↓
Hermes / OpenClaw / Self-built Runtime
```

## 55. 第三方 Runtime 不自动升级生产环境

新版本必须进入测试环境，经过 Compatibility Eval、Security Eval 和 Performance Eval，通过后才成为 Candidate Upgrade。

## 56. AI 与 Jarvis 通信优先 MCP

Codex、Claude Code、Hermes、OMP 等 AI 工具通过 Jarvis MCP 调用：`search_memory`、`get_project_context`、`find_file`、`get_decisions`、`get_failures`、`save_experience` 等。

## 57. 普通软件与 Jarvis 通信优先 HTTPS API

手机、Android Agent、NAS Indexer、Development Recorder、Rokid Bridge 等普通程序使用 API。

> **MCP 是给 AI 的门，API 是给软件的门。**

## 58. Development Recorder

每台开发设备都可以安装轻量 `jarvis-dev`，记录 Repo、Git Diff、Commit、Test、Codex Session、Claude Session 和 Build Result，并把结构化开发过程传回 Jarvis。

## 59. Codex 可以在笔记本开发，Jarvis 可以在远程服务器

Codex 通过 Jarvis MCP 获取正确的项目上下文，代码仍在笔记本上修改，不要求开发迁移到 Linux Server。

## 60. Codex 可以自动 Git Commit，但不默认自动 Merge 生产

推荐流程：任务完成 → 测试 → Diff 检查 → Secret 检查 → Git Commit；可逐步允许自动 Push 到实验 Branch；默认禁止自动 Merge 生产 main。

## 61. Codex 应该看到生产环境真实问题

Jarvis 把 Logs、Metrics、Traces、Health Checks、Incident、最近 Commit 和环境信息组织后提供给 Codex。Codex 不需要与生产服务器处在同一台设备。

## 62. 生产权限必须分级

允许读取日志、查看状态、读取非敏感配置；重启服务、修改配置和部署需要审批；删除数据库、清空 NAS、读取 Secret Vault 等默认禁止。

---

# 第十部分：核心设计原则

1. **Every token should leave a trace.** 每次重要推理都应该留下可追溯结果。
2. **Every failure should become an eval.** 每次失败都应该减少未来重复犯错。
3. **Every repeated success should become a skill.** 重复成功应沉淀成能力。
4. **Never trust external capability by default.** 任何外部能力默认不可信。
5. **Raw data survives model interpretation.** 原始资料不能因为 AI 总结而消失。
6. **User owns strategy; Jarvis owns tactics within permission.** 用户控制战略与边界，Jarvis 负责授权范围内的战术执行。
7. **Local data, rented intelligence.** 核心数据尽量自持，世界级智能可以按需租用。
8. **One Jarvis, many specialists.** 用户面对一个 Jarvis，后台按需调用不同专家与工具。
9. **Evolution must be measurable.** 所谓进化必须能通过 Eval、Benchmark 或真实结果证明。
10. **Everything powerful is permissioned.** 能力越强、影响越大，权限越必须明确。

---

# 第十一部分：开发路线

## Phase 0 — Constitution（当前）

完成：本文档、隐私规则、自主规则、外部 Skill 安全规则、目标体系、数据所有权与 Agent Runtime 边界。

## Phase 1 — Jarvis Core v0.1

先在现有开发笔记本完成，不要求购买新硬件。

### 目标

让 Jarvis 第一次真正认识用户，并能把正确上下文交给 Codex。

### 功能

1. Conversation Import：支持 ChatGPT Export、Claude Export、Markdown、JSON、TXT。
2. Raw Source Vault：原始资料完整保留。
3. Context Database：至少包含 Projects、Memories、Decisions、Open Loops、Goals、Relationships。
4. Search：能搜索历史聊天、项目和来源。
5. Ask Jarvis：能回答“我有哪些项目、为什么做、做到哪里、以前做过什么决定、还有什么没完成”。
6. Jarvis MCP：让 Codex 能调用 `get_project_context()`、`search_memory()`、`find_decision()`、`get_open_loops()`。

### 第一阶段验收标准

> **Codex 能否在开始开发前，主动从 Jarvis 获得正确、完整、不过度的历史上下文。**

## Phase 2 — 正式 Jarvis Server

v0.1 稳定后再迁移到 MS-A2 或同级 24 小时在线设备，运行 Jarvis Core、Memory、Database、Search、Scheduler、MCP、API。

## Phase 3 — NAS Intelligence

实现 NAS Watcher、File Indexer、Metadata、Full Text、Tags、Semantic Search。先监控测试目录，稳定后逐步扩大。

## Phase 4 — Development Integration

开发 `jarvis-dev`，连接 Codex、Claude Code、Git、Tests，使 Jarvis 自动知道每次开发做了什么、修改了什么、结果如何、Bug 与下一步是什么。

## Phase 5 — Research Engine

建立 Source Registry、Research Queue、Curiosity Engine。第一批领域建议：AI / Agent、Android、本地模型、Jarvis 自身。

## Phase 6 — Model Router & Compute Economy

统一管理 GPT、Claude、Codex、API、本地模型、Coding Plans、Token Quota 和 Cost，开始自动选模型。

## Phase 7 — 第一台 AI Worker

不买新 GPU 服务器，先接入现有 RTX 4080 PC，验证 Jarvis → 远程派发任务 → 4080 执行 → 返回结果的闭环。

## Phase 8 — Android Worker

将 RedMagic 24GB + 1TB 作为 Jarvis Mobile Node + 7B Worker，承担本地隐私过滤、手机事件分类、STT、小模型、Android Agent、Rokid Bridge。

## Phase 9 — Worker Pool

逐渐增加 Steam Deck、旧 PC、旧 NAS、RedMagic、4080 和未来 AI Server。

## Phase 10 — Specialist System

按真实需求动态建立 Health、Finance、Development、AI Short Drama、Research 等 Specialist。

## Phase 11 — Evolution Engine

实现 Failure Mining、Eval、Skill Candidate、Gene、Capsule、AutoResearch、Sandbox Experiment、Regression Test。开始真正形成“Jarvis 优化 Jarvis”。

## Phase 12 — External Capability Network

最后才接入 EvoMap 或其他 Agent/Skill Network。所有外部能力必须经过 Quarantine、Security、Permission、Sandbox、Eval 后才可使用。

---

# 第十二部分：设备演进原则

初始阶段不要求 MS-A2、5090、双 GPU Server 或新 NAS。

建议顺序：

```text
开发笔记本 + 现有 NAS
        ↓
Jarvis Core v0.1
        ↓
MS-A2 / 同级 Jarvis Server
        ↓
NAS 自动索引
        ↓
现有 RTX 4080 成为第一个 AI Worker
        ↓
RedMagic / Steam Deck / 旧电脑陆续加入
        ↓
未来双 5090 AI Server
```

Jarvis Server 是司令部，NAS 是档案馆，AI Server 是重型实验室，各角色不混用。

---

# 第十三部分：讨论过程与主要问题记录

本部分不是产品功能清单，而是保留从最初想法到当前架构的思想碰撞。

## Q1：怎样把“无限 Token”投入到一个会越来越强的东西？

最初结论：不能只是不断增加上下文。Token 最终应该留下 Knowledge、Memory、Experience、Skill、Tool、Eval。后续进一步扩展为 Research、Experiment、Gene、Capsule 和 Source Registry。

真正可以持续投入 Token 的地方是：**持续研究世界 + 持续实验 + 持续评价 + 持续优化。**

## Q2：把所有历史聊天导进去，Jarvis 就能认识用户吗？

历史聊天是极其重要的第一批原始资料，但不能只做“聊天摘要”。应提取 Projects、Decisions、Memory、Goals、Open Loops、Experience 和 Relationships，并保留完整原文以便未来重新理解。

## Q3：用户自己不知道的东西，Jarvis 怎么知道？

通过 Knowledge Gap Detection + Source Registry + 主动联网研究。Jarvis 的目标不是等用户教会一切，而是知道“我不知道什么”并知道去哪里找。

## Q4：是不是把所有软件都塞进 Jarvis？

不是。最终形成原则：**统一大脑，不统一代码。** 各项目独立存在，Jarvis 负责理解、关联和调度。

## Q5：本地模型不够聪明怎么办？

采用 Hybrid：本地负责隐私、筛选、索引、简单任务；高难推理按权限调用强云端模型。无需为了私人 AI 强行在本地复刻最强模型。

## Q6：第一步是不是 Memory？

进一步修正为 Personal Context Core。除了 Memory，还必须理解 Projects、Goals、Decisions 和 Open Loops。

## Q7：Jarvis 大脑放在哪里？

最终分工：Jarvis Server 运行控制中心；NAS 保存长期档案；Cloud Model 提供外部智力；AI Server 提供重型本地算力。

## Q8：第一遍理解历史资料是否应该使用强模型？

是。第一份个人 Context 非常重要，可以舍得调用强模型；同时永远保留原始资料，未来可以使用更强模型重新解释。

## Q9：Codex 能不能成为 Jarvis？

不建议。Codex 是极强的开发执行者；Jarvis 是长期总管。Jarvis 应调用 Codex，而不是被 Codex 取代。

## Q10：Jarvis 怎么自动研究？

从目标体系、真实问题、失败记录、新技术变化中产生研究问题，再通过 Source Registry、Research、Experiment 和 Eval 闭环，而不是随机刷互联网。

## Q11：Hermes/OpenClaw 能不能做底座？

可以作为 Agent Runtime，但不能承载 Jarvis 的永久核心。必须通过 Adapter 连接，确保可替换。

## Q12：Jarvis 怎么“自己进化”？

不是重新训练模型，而是持续改进 Skill、Prompt、Tool、Retrieval、Model Routing、Research Process、Source Registry，并且每次升级必须有 Eval。

## Q13：Jarvis 在 Linux Server，Codex 在笔记本，怎么协作？

通过 Jarvis MCP。Codex 在笔记本开发，通过 MCP 远程读取 Jarvis 提供的项目上下文和记忆。

## Q14：Codex 如何知道生产服务器实际出了问题？

Jarvis 必须有 Observability。真实 Logs、Metrics、Traces、Health Checks 和 Incident 自动整理后提供给 Codex，而不是依赖用户发现。

## Q15：AI Server 是什么？

不是 Jarvis 本体，而是专门放 GPU 干重活的计算节点，承担大模型、视频生成、大量 Eval、Agent Farm、Fine-tuning 等工作。

## Q16：RedMagic 可以成为算力节点吗？

可以，定位为 Edge AI Worker / Mobile Node，可运行小模型、STT、隐私过滤和 Android Agent，但不能承担关键基础设施。

## Q17：Steam Deck、旧电脑、旧 NAS 能不能参与？

可以，组成 AI Worker Pool。它们并不是合成一个更大模型，而是被 Jarvis 按能力、负载、成本和隐私并行派工。

## Q18：健康专员的知识从哪来？

不是下载全世界所有医学书。应结合专业模型、可信 Source Registry、用户授权健康数据、最新资料和强模型综合，同时强调证据、不确定性与专业医疗边界。

## Q19：理财专员呢？

同样采用专业数据、可信来源、用户上下文和合适模型，但默认不允许自动交易和资金操作。

## Q20：Source Registry 需要进化吗？

需要。它是 Jarvis 自主学习能力的关键资产，应持续评估来源权威性、准确率、新鲜度、相关度与噪声。

## Q21：AI 短剧这样的新领域怎么办？

动态创建新 Domain，随着用户兴趣和研究投入逐步形成专业知识、工作流、实验、Skill 和 Specialist。领域能力是“长出来的”。

## Q22：Jarvis 应该多主动？

最终授权到 Level D：可以自动研究、实验、Coding、Branch、Testing、Candidate；默认不能未经批准直接生产部署。

## Q23：Jarvis 应该知道用户多少？

在隐私保护、领域分仓和主动授权的前提下尽可能多，但绝不是无条件知道全部。

## Q24：目标从哪里来？

采用长期目标 → Project Goal → Current Problem 三层目标。Jarvis 可以主动提出新目标，并形成每周工作计划供用户批准或调整。

## Q25：需要把所有可用 Token 都烧完吗？

不需要。应根据 Information Gain / Capability Gain 决定是否继续。云端 API 还必须考虑真实成本。

## Q26：旧知识怎么办？

原始资料不删，旧结论降权并保留历史依据。当前知识与历史知识并存。

## Q27：EvoMap/EvoX 给 Jarvis 什么启发？

三个重要思想：Gene / Capsule / Event；Agent 可以继承外部能力；AutoResearch + Swarm 可以用于“AI 优化 AI”。但 Jarvis 不直接相信网络能力，必须本地验证。

## Q28：外部 Skill/Gene 最大风险是什么？

供应链安全。最终确立最高级规则：**任何外部能力默认不可信。** 必须经过 Quarantine、Permission Analysis、Security Scan、Sandbox、Fake Data、Eval 才允许进入 Candidate。

---

# 第十四部分：当前下一步

当前不再继续扩大未来设想，正式进入：

## Jarvis Core v0.1

第一批实际开发工作：

1. 设计 Jarvis Core 数据模型；
2. 设计 ChatGPT Export / Claude Export 导入器；
3. 建立 Project / Memory / Decision / Open Loop / Goal 提取流程；
4. 建立基础 Search；
5. 建立 Jarvis MCP；
6. 让 Codex 在开发前能调用 Jarvis 获取正确上下文。

第一阶段只看一个核心验收问题：

> **Codex 能否在开始开发之前，主动从 Jarvis 获得正确、完整、不过度的历史上下文？**

如果可以，Jarvis 的第一块真正核心能力就已经诞生。

---

# 结语

Jarvis 不应该追求“什么都知道”，而应该追求：**知道自己不知道什么，并且知道如何安全地获得它。**

Jarvis 不应该追求“什么都自动做”，而应该追求：**知道什么可以自主完成，什么必须请求授权。**

Jarvis 不应该追求“永远使用最强模型”，而应该追求：**用最合适的能力，以最合适的成本、权限和隐私级别完成任务。**

Jarvis 不应该追求“一次构建完成”，而应该成为：

> **一个可以陪用户多年持续成长、持续纠错、持续获得新能力，但始终可审计、可回滚、可控制的私人 AI 系统。**
