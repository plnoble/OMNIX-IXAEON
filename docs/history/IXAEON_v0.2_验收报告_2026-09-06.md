# IXAEON v0.2 验收报告

审核日期：2026-09-06。

审核提交：`f83138749f788490c68b04f5f4d0d880cd38485b`（`feat: M3 编码 AI 的开工与收工闭环（来源标注/覆盖版本/回写幂等）`）。

审核范围：[v0.1.1 → v0.2 开发计划](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_下一阶段开发计划_v0.1.1到v0.2.md) 的 M0–M3，以及第四次验收的 F1–F4。此次没有交付 Door 实现，因此不按 v0.3 的设备能力要求扣分。

## 结论：修复有进展，但 v0.2 暂不通过完整验收

旧问题不是原地踏步：第四次验收的 7 项测试、此前两轮的 24 项测试全部通过；新加入的真扩展到真实本地服务串联测试也通过了。

但是新阶段的关键承诺仍有缺口：**任务取消后仍可能写入、人工纠正后旧决定会复活、相反的新意见会被当作重复丢掉、换项目时可能把理解写回旧项目，“已经分析最新内容”也可能不是真的。**

本轮增加 15 项针对性检查，14 项失败、1 项正向对照通过，归为 G1–G8。它们是按计划要求选取的反例，不代表整个产品随机抽样的通过率。

建议先修本报告，再审核 v0.2；暂不开始 Door，避免在还不可靠的记忆和任务状态上增加设备数据。

## 一、实测结果与边界

| 检查 | 实际结果 | 说明 |
| --- | --- | --- |
| `corepack pnpm verify` | 通过 | lint、格式、类型、构建；16 单元 + 126 集成 + 11 二次回归 + 13 三次回归 + 7 四次回归，共 173 项测试 |
| `corepack pnpm test:e2e` | 通过 | 桌面 10 项；扩展受控网页测试；真实扩展→实际桌面服务→实际 SQLite 的串联测试 |
| 打包产物复核 | 3 项通过 | 目录选择开关；公开 IPC 设置目录后完整重启保留项目；仓库外打包副本、仅 System32 PATH 下的 MCP 握手／四工具调用／持久化写回 |
| 本轮 V01–V15 | 1 通过、14 失败 | 生产服务／提取器／队列／迁移／契约，合成数据和 FakeProvider |
| 新增测试的 lint／类型检查 | 通过 | 失败来自业务断言，不是编译或框架加载失败 |
| 真实模型、真实 ChatGPT 登录网页 | 未执行 | FakeProvider 与受控网页不能替代真人环境验收 |
| 真实编码 AI 完成授权小任务并回写 | 未执行 | 四工具脚本读写不能替代这一项 |
| 安装器、新 Windows 用户、短期日用观察 | 未执行 | 实际启动的是 `win-unpacked` 副本，没有安装到用户系统 |

安装包实测：122,580,929 字节；SHA-256 与当前交付说明一致：

```text
899B937C623C001D8F1F888E6FD60BB8D9A0BD1C87C1CBCDCC1C549625E8AFFC
```

打包复核临时副本：`C:\Users\87953\AppData\Local\Temp\ixaeon-packaged-review-5SYAjE`。测试进程已结束，临时测试资料保留用于检查。

本次没有修改生产代码、既有测试、旧计划或旧报告，只新增本报告、独立测试配置、测试文件和结果 JSON。没有使用真实账户、读取 API Key 或调用收费模型。

## 二、分阶段判断

| 阶段 | 判断 |
| --- | --- |
| F1–F4 原始复现 | 本轮全部通过；不能笼统说上轮没有修好 |
| M0 可靠任务与版本状态 | 未通过：实际取消信号、崩溃遗留任务、分支切换和旧库迁移仍有问题 |
| M1 归属和真实状态 | 未通过：手工归属与分析中的归属变更保护不足；状态可能错误显示追平 |
| M2 确认与改口 | 未通过：确认按钮和字段已存在，但没有形成完整的人工决定保护机制 |
| M3 编码 AI 闭环 | 基本读写通过；覆盖版本、待确认语义、幂等和引用／预算契约未通过 |
| v0.3 Door | 不在本次实现与验收范围 |

## 三、必须修复的问题

### G1 · P1：任务标成“已取消”，结果却已写入

位置：[appRuntime.ts:291](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:291)、[appRuntime.ts:333](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:333)、[jobQueue.ts:139](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/jobs/jobQueue.ts:139)。

**V01 实测**：模型请求返回前调用实际 `JobQueue.cancel(job.id)`。结束后任务状态确实为 `cancelled`，但新增了 1 条理解，已分析版本也从 0 变成 1。

原因：队列传入了 `ctx.signal`，提取处理器却没有接收；注入 Extractor 的 `shouldContinue` 只检查自动开关／暂停，手动任务直接返回 true。等处理器写完数据库后，队列才按 abort 状态把任务标为取消。

修复要求：

- 将真实取消信号与自动任务的开关／暂停检查组合，覆盖手动和自动提取。
- 每个新模型块前、提交理解和推进版本前检查；取消不写新结果、不推进已分析版本。
- 停止／恢复前真正等待或隔离在途任务。不能只取消计时器或只改变任务标签。
- 补测取消、退出、恢复发生在模型等待期间的情况。已发出的网络请求不能声称可收回，但不得继续发送后续块或提交被取消的结果。

现有“取消后模型返回”门槛测试主要通过改变 `autoAnalyze` 模拟取消，没有覆盖真实队列取消信号，因而会漏过本问题。

### G2 · P1：崩溃留下 running 任务后，来源无法自动恢复分析

位置：[appRuntime.ts:205](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:205)、[appRuntime.ts:230](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:230)、[jobQueue.ts:76](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/jobs/jobQueue.ts:76)。

**V02 实测**：构造崩溃后会留下的真实数据库状态——来源版本 1、已分析版本 0、一条 `running` 提取任务。新队列与运行时扫描后，模型调用为 0，版本仍为 1／0。

原因：启动扫描将数据库中任意 `running` 记录都当成仍有进程执行而跳过；执行器又只领取 `queued`。没有人把失去执行者的旧 running 任务恢复出来。

修复要求：

- 明确单实例运行时的任务归属，在安全启动阶段识别上一运行代次的遗留任务。
- 将其转为可恢复状态或重新排队，重新检查权限、暂停、版本和重试预算；不能直接当作成功。
- 补“任务正在运行时进程退出／崩溃→新进程打开同一测试库→恢复最新分析”的完整测试。

本轮是遗留数据库状态模拟，不是实际强杀用户进程。既有重启测试仅覆盖“还未形成 queued/running 任务”的场景，不覆盖此情形。

### G3 · P1：三处版本判断会把“未分析”说成“已分析”

#### G3a：切回旧回答不更新版本

位置：[sourceStore.ts:331](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/sourceStore.ts:331)、[sourceStore.ts:350](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/sourceStore.ts:350)。

**V03 实测**：同轮回答 A→B，分析完 B，再切回 A。当前片段确实切回 A，但内容版本和已分析版本仍同为 3，没有标记需要重分析。

原因：旧指纹重新激活被算作 deduplicated，只有 accepted > 0 才递增版本；本地自动分析入口也会忽略 accepted = 0。

修复：区分“没有变化的重复提交”和“切换了当前有效内容”。后者必须递增来源版本并进入待处理流程，不只是调整一个计数。

#### G3b：不能比较不同来源各自的最大版本

位置：[mcpStore.ts:211](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:211)。

**V04 实测**：A 来源版本 1／已分析 1，B 来源版本 1／已分析 0；简报却返回 `hasUnanalyzedContent=false`。

原因：分别取所有来源的 `MAX(content_revision)` 和 `MAX(analyzed_revision)` 再比较，两个最大值都为 1。但它们不代表每个来源都已分析。

修复：按每个来源检查版本差，再聚合为“存在待分析内容”；覆盖说明应能指出哪些来源落后。来源自己的版本号不是全项目统一时间线。

#### G3c：迁移不能凭空宣布旧数据已分析

位置：[migrations.ts:189](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/db/migrations.ts:189)。

**V05 实测**：在旧版 schema 中保存一个从未分析的来源及片段，items 和 jobs 均为空。升级后被统一写成 `content_revision=1, analyzed_revision=1`。

原因：为避免升级时批量调用模型，迁移直接把全部旧来源视为已分析；这与真实状态要求冲突。

修复：没有成功证据的记录标未知／待分析，是否自动补分析另受用户开关、预算和迁移提示控制。**避免收费调用是合理目标，但不能通过伪造完成状态实现。** 修复已执行过迁移的测试库时，不能只修改旧迁移脚本；要提供追加迁移或安全的状态修复方案。

### G4 · P1：人工纠正会失效，真实的新冲突又可能被丢掉

位置：[extractor.ts:120](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:120)、[extractor.ts:170](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:170)、[extractor.ts:329](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:329)。

- **V06**：先提取“启用远程项目日志”，用户纠正为“不要远程日志，只保存在本地”，再提取同一来源。旧决定重新作为 `current` 出现在 MCP decisions 中；纠正虽然没被删除，但没能阻止旧决定复活。
- **V07**：用户已确认“允许把项目记录上传到远程服务器保存”，后来原文新增“不允许把项目记录上传到远程服务器保存”。新的、有真实引用的相反结论被跳过，没有形成可处理的冲突条目。

原因有两层：

1. 保护查询只看当前来源的 `origin=ai` 且 confirmed/rejected 条目，没有沿 corrections 链保护用户纠正后的结论；冲突检测又只看 AI 条目。
2. 把字符 bigram 相似度 ≥ 0.6 直接当作同义重复。只差一个“不”的相反意见也高度相似，因而被丢弃。

修复要求：

- 保护真正的人工纠正链，而不只是保护“确认”按钮产生的字段。
- 旧决定不得重新作为不带警告的当前决定；新证据与人工决定冲突时保留为待讨论，不替用户选边。
- 字符相似度只能帮助寻找候选关联，不能证明语义相同；不确定时保留依据并请求确认，不能直接跳过。
- 分别测试确认、不采纳、纠正、反向意见及分析期间发生人工操作，不能用一个 rejected 相似文本用例概括“改口保护全部完成”。

本轮没有评价真实模型的语义正确率。验证的是：系统收到格式合法、有真实引用的提取结果后，是否正确保存并尊重人工操作。

### G5 · P1：来源绑定不能保护手工归属，也挡不住在途分析写回旧项目

位置：[sourceStore.ts:393](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/sourceStore.ts:393)、[extractor.ts:223](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:223)。

- **V08**：来源原属 A；用户把其中一条 AI 条目单独归属 B；之后把来源改属 C。该条目被静默搬到 C，用户先前的单独归属丢失。
- **V09**：分析开始时来源属于 A；等待模型时用户把来源移到 B；模型返回后，新理解仍写入 A，并出现在 A 的 MCP 简报中。

原因：来源绑定批量移动所有非 superseded 的 AI 条目，不区分自动继承与人工单独归属；提取器则在网络请求前读了一次 source.project_id，提交时仍使用旧值。

修复要求：

- 保存归属的来源／人工操作记录，来源批量改绑不能覆盖单独的人工作用。
- 提交前重新验证来源归属及相关状态版本。发生变化时取消重试，或以一致的新归属提交；不能让旧任务把数据写回旧项目。
- 受影响的纠正／确认条目需要明确保留或进入待处理，不得静默丢失、搬移或以旧归属进入简报。
- 测试界面操作、数据库状态和 A／B／C 项目的 MCP 输出，不能只验证 sources.project_id 更新成功。

### G6 · P1：重要决定未经确认，却绕过待处理流程

位置：[extractor.ts:224](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:224)、[mcpStore.ts:109](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:109)。

**V10 实测**：给已绑定项目的来源提取一条重要 decision，条目为 `confirmation=none`，却同时为 `needs_review=false`；MCP 将它放进 decisions，既没有待确认说明，也没有独立的确认状态字段。

原因：是否进入待处理主要取决于有没有项目，并没有对重要决定应用确认策略。MCP 的 `origin=ai` 只说明由 AI 提取，不等于说明用户是否确认过。

修复要求：

- 按计划明确重要决定／冲突的确认策略，与“属于哪个项目”分开。
- UI 能找到需要用户确认的条目；MCP 输出区分已确认、未确认、冲突，不靠调用方猜测缺少后缀意味着什么。
- 未确认的理解可以提供给编码 AI，但必须明确标为待确认／风险，不能混成用户已拍板的背景。

本轮测试允许用明确的结构化字段、风险分组或可读文案表达待确认，不强制只能使用某一句固定文案。

### G7 · P1：工作回写幂等丢掉项目／提交差异，还破坏引用契约

位置：[mcpStore.ts:451](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:451)、[mcpStore.ts:470](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:470)、[mcpStore.ts:488](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:488)、[mcp.ts:134](D:/Agent/Project/OMNIX-IXAEON析衍/packages/contracts/src/mcp.ts:134)。

- **V11**：相同 client_ref 与相同正文先提交项目 A，再提交项目 B；第二次被当成成功重试，返回 A 的工作记录，B 没有自己的记录，也没有收到项目不一致的冲突提示。
- **V12**：相同键把 commit_ref 从 commit-one 改成 commit-two，被当作相同请求接受；比较条件没有包含提交引用。
- **V13**：契约允许最长 200 字符的 client_ref；实测一个合法的 121 字符键被直接用作 work_run_id。后续引用最多允许 100 字符，所以生成的简报违反输出契约，展开该引用的输入校验也拒绝它。

修复要求：

1. 明确幂等键是全局还是项目内唯一；无论选择哪一种，都不能把 A 项目记录冒充 B 项目的成功写入。
2. 比较规范化后的全部有意义字段，至少包含解析后的项目 ID 与 commit_ref；同键不同内容明确冲突。
3. 幂等键与内部记录 ID 分开保存。内部引用继续满足所有读取接口和实体契约。
4. 重试返回可用、可追溯的原记录；补跨项目、不同 commit、最长键、后续展开引用和并发重试测试。

V13 的长度兼容问题本身为 P2；与 V11／V12 一并修复幂等实现，避免再次只测“重复请求返回同一个 ID”。

### G8 · P2：简报字符预算只算条目，完整输出仍超限

位置：[mcpStore.ts:178](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:178)、[mcpStore.ts:218](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/mcpStore.ts:218)。

**V14 实测**：传入 `max_chars=2000`，完整序列化输出为 2301 字符。任务、项目字段、coverage、时间、状态提示和 JSON 容器没有全部计入预算。

修复：按完整返回值核算，预留必要元数据，迭代裁剪后再次检查。不能只修改 chars_used；必要的待确认、过期、权限等提示不能被优先裁掉。补长任务描述、大量条目、新 coverage 字段和最小预算边界测试。

## 四、验收材料仍缺哪些证据

开发日志已经如实列出部分未完成项，这些应保留，不要改成“全部已验证”：

1. M2 计划要求的六类固定语义资料，在界面、持久化、MCP 输出之间的串联验收。当前仍未完整交付；这部分可以先用合成资料与 FakeProvider 自动化，不必等待真实 Key。
2. 真实 ChatGPT 网页的采集、刷新、暂停、可见性时限。受控页面串联通过不是当前真实站点通过。
3. 原计划六组问题与新语义情形的真实模型回答，按预先写好的判据审核。
4. 真实编码 AI 客户端完成一项安全、授权的小任务并回写。独立 STDIO 客户端调用四工具证明协议链路，不证明 AI 实际遵循了开工／收工流程。
5. 安装器与干净账户、旧版升级、完整界面目录选择、短期日用观察。

前两项中的自动化缺口应由开发补齐；真实登录、付费、安装等需要用户参与的部分单独列成操作清单。**即使真人验收暂时缺条件，也不能用它解释本报告中无需账户即可复现的代码缺陷。**

## 五、复跑与修复交付

独立测试：[v02-acceptance-20260906.test.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/v02-acceptance-20260906.test.ts)。

结果记录：[results-v02-20260906.json](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-v02-20260906.json)。

在仓库根目录执行：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.v02-review.config.ts
corepack pnpm verify
corepack pnpm test:e2e
node apps/desktop/test/review/packaged-20260905.mjs
```

第一条目前退出码为 1，是本轮业务断言失败；其余命令本轮实测通过。端到端和打包复核顺序运行；有用户实际服务占用端口时不要杀用户进程。

测试方法说明：每项使用独立临时库；FakeProvider 只提供合法的合成响应，不连接网络；V01 使用实际队列取消；V02 模拟崩溃遗留状态；V05 从真实初版 schema 执行当前迁移；V09 在模型等待窗口执行实际改绑。V15 正向对照确认正常提取仍可成功写入并推进版本。没有把测试装载失败计为产品缺陷。

修复顺序建议：

1. **G1–G3：任务与版本事实先正确。** 取消、崩溃恢复、分支、迁移、覆盖版本形成一致机制。
2. **G4–G6：人工决定与项目归属保护。** 将确认、纠正、归属、重新分析作为完整流程测试。
3. **G7–G8：工作回写与输出契约。** 从合法输入一路验证到重复提交、再次简报和引用展开。

修复 agent 应将本组测试纳入默认验证，保留本次失败 JSON，另存修复后证据。若修复需要调整数据契约，可修改测试适配，但不能删除或弱化这些业务要求。最后重建产物、核对源码提交和哈希，更新审核包，再交回验收。

只有旧回归、新增反例、必要串联和真人发布门槛均完成后，才可以称 v0.2 完整通过；现在不宜进入 Door 开发，也不应把此版本当作项目资料的唯一保管位置。
