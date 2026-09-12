# v0.3 开发日志

## 2026-09-08 · S0：目标、数据和入口清点（第一批第 1 部分）

交付四份 S0 文档（纯文档，无业务代码改动）：

1. `docs/v03-baseline.md` —— 现状清点：HEAD 3a6fe76（v0.2.3）；继承底座
   （记忆内核原因集合/MCP 四工具/ChatGPT 采集/GitHub 自动更新/导入矩阵）
   逐项证据；v0.2 遗留真实验收缺口如实（真实旧库升级/安装器全流程/
   C・D・E 组实机）；v0.3 各能力到现有代码的接入点；兼容与有意收紧清单。
2. `docs/v03-source-support.md` —— 四平台逐项：ChatGPT（导出+增量均 ✅）；
   Gemini/Grok/Claude **待用户提供脱敏导出样本**（无样本不写解析器，
   不臆造格式）；S2 通用规范（命名空间/保守去重/附件元数据/编辑版本化）。
3. `docs/v03-capability-access.md` —— 本机实际核实：**Codex CLI 0.130.0-alpha.5**
   （`codex exec` 非交互模式存在，auth 已登录，gpt-6-astra）为 S5 首选执行
   入口（完整旗标表实施时以 --help 实测为准）；Claude CLI 未找到可执行文件；
   grok CLI 存在但本版不接；**搜索服务未配置**——S4 第一版围绕批准来源
   （发布页/订阅源）运行，不声称全网搜索。
4. `docs/v03-acceptance-map.md` —— A01–A22 + T01–T05 全部空记录（不预填
   通过）；T01 标注部分完成（用户已实测 DeepSeek 分析+问答 2 问通过），
   T05 标注覆盖升级实际发生但无结构化记录。

### 关键选择

- 执行入口优先 Codex CLI（可用性/取消/沙箱旗标满足选型标准），单工具单任务。
- 研究第一版零新增费用：批准来源检查 + 内容指纹去重，搜索 API 待用户决定。
- 旧 `project_id=null` 保守映射 unassigned（不自动升级为 personal）。

### 需用户确认（阻塞对应项）

1. Gemini / Grok / Claude 各一份脱敏导出样本（S2 对应解析项）；
2. Codex CLI 作为执行入口 + 默认隔离参数是否认可（S5）；
3. 是否配置付费搜索 API（S4；不配置 = 仅批准来源检查）。

### 未完成与下一步

- S0 完成；S1（个人层与权限模型：scope 列迁移 11、主题关联、范围校正、
  权限贯穿）不依赖样本，可直接开始。
- 四平台样本、搜索服务、执行入口确认到位前，对应 S2/S4/S5 项保持受阻
  标记，不降低验收标准。

## 2026-09-09 · S1：个人层与权限模型（第一批第 2 部分）

交付迁移 11 + 范围/关联/分享授权贯穿后端，无破坏已发布迁移 1–10。

### 本批内容

- `items.scope`：`personal` / `project` / `unassigned`。旧 `project_id != null`
  → project；旧空归属 → unassigned（不自动升级 personal）。
- `no_project` 只由 `unassigned` 派生；标为 personal 或归属项目只清这一原因。
- `item_links`：条目可关联多个项目/主题，不复制原文、不等于共享权限。
- `disclosure_grants`：编码客户端默认只见 `scope=project`；个人/未整理须显式
  分享，撤权立即失效。旧 localToken 不自动解锁个人资料。
- 桌面：问答默认「个人视角（不选项目）」；待讨论增加「标为个人」。
- 导出 `data/item-links.json`、`data/disclosure-grants.json`；清单版本 2，
  仍接受旧清单 1 恢复。

### 自动化

- 新增 `packages/core/test/integration/s1-scope.test.ts`（A01/A02/A11/A12）。
- A03/A04 的既有纠正语义沿用 v0.2 回归；本批只增范围维度。
- A11 研究查询/任务背景、A12 真实旧库升级仍未完成（T05）。

### 未完成与下一步

- S2：四平台导入（Gemini/Grok/Claude 仍待脱敏样本）。
- 不把本批写成「全部验收通过」：真实验收 T01–T05 未完。

## 2026-09-09 · S2：多来源输入与项目目录（第一批第 3 部分）

交付迁移 12 + ChatGPT 规范化导入 + 多项目登记。Gemini/Grok/Claude **无样本，不写解析器**。

### 本批内容

- `sources.account_namespace`：去重键改为 (provider, namespace, external_id, content_hash)。
  跨账号相同对话 ID 不合并。命名空间用户自命名，不读密码/Cookie。旧来源映射 `local`。
- ChatGPT 导出写入规范化元数据：平台、命名空间、对话标识、导入方式、缺失字段、未解析附件。
  缺 conversation_id 用内容指纹，不凭标题合并。附件只记元数据，不拉 URL。
- 项目可一次登记多个；构想可以没有目录。同根路径不自动合并。导入授权仍只读。
- 界面写明：历史导出 ≠ 后台读整个账号；扩展只采当前打开可见对话。

### 自动化

- 新增 `packages/core/test/integration/s2-import.test.ts`（A05 ChatGPT / A07）。
- A06 沿用 v0.2 扩展 e2e；本批只补边界文案。
- A05 三平台解析 ⛔ 受阻（无脱敏样本）。

### 未完成与下一步

- S3 个人理解与跨项目统筹。
- 不把本批写成「全部验收通过」：T01 四平台导入、T02 真机采集未做。

## 2026-09-09 · S3：个人理解与跨项目统筹（第一批第 4 部分）

交付迁移 13 + 关系提案生命周期 + 个人总览/问答覆盖。不接联网或 Shell。

### 本批内容

- `project_relations`：服务于目标 / 依赖 / 能力 / 可复用 / 疑似重复 / 冲突。
  状态 proposed/accepted/rejected/superseded；verification 与 accepted 分开。
- 同样证据指纹被拒绝后不再催促；新实质证据可出新版本；纠正后旧关系 stale。
- 候选生成按陈述 token 重叠，不靠项目名；无证据不强连；不移动资料。
- 总览改为个人视角（目标/约束/未知/各项目/提案）。问答按问题筛选并附覆盖说明。
- 有界统筹器：白名单 retrieve/evidence/proposal/stop，校验 ID，无效响应失败退出。

### 自动化

- 新增 `packages/core/test/integration/s3-orchestration.test.ts`（A08/A09/A10）。
- A10 真机四问、模型轮数精细预算仍未完成。

### 未完成与下一步

- S4 主动研究（无搜索 API 则只检查批准来源）。
- 不把本批写成「全部验收通过」。

## 2026-09-09 · S4：批准来源检查（第三批）

交付迁移 14 + 关注主题/来源/发现/运行记录 + HTTPS 安全抓取。不接搜索 API，不声称全网搜索。

### 本批内容

- 创建关注默认关闭自动检查；启用后 24h；立即检查可不启用自动监控。
- 只抓用户批准的 HTTPS 发布页/RSS；DNS+重定向逐跳校验；禁 file/回环/私网/元数据。
- 内容指纹去重（排版空白不计）；失败不覆盖成功水位；外部事实不写入用户偏好。
- 网页诱导命令/上传不当授权。付费预算 mode=none。

### 自动化

- 新增 `packages/core/test/integration/s4-research.test.ts`（A13–A17）。
- T03 真实公开网站未跑。

### 未完成与下一步

- S5 最小编码执行（Codex CLI 待用户确认默认隔离值）。
- 不把本批写成「全部验收通过」。

## 2026-09-09 · S5：最小编码执行闭环（Fake 先行）

交付迁移 15 + 任务批准绑定 + Fake 执行器 + 独立验证。Codex CLI 旗标已按 `exec --help` 核实，真机派发未开。

### 本批内容

- 状态：草案 / 等待批准 / 排队 / 执行中 / 待验证 / 待接受 / 完成 / 失败 / 取消 / 不明。
- 批准绑定版本、工作区、范围、允许命令；过期/修改后失效；越界拒绝。
- Fake 适配器写入隔离工作区，不拼 shell、不传 IXAEON 密钥。
- 执行器自报成功不能当验收；独立验证失败保持失败；未跑写未运行。
- 同 dispatch_key 幂等；取消后晚到不覆盖；重启 running → unknown。
- 接受结果不自动合并/部署。界面标明 Fake，真机待确认。

### 自动化

- 新增 `packages/core/test/integration/s5-execution.test.ts`（A18–A21）。
- T04 真实 Codex 派发未做。

### 未完成

- 真机 Codex 派发与 T01–T05。不得写成全部验收通过。

## 2026-09-09 · 补齐 A04/A11/A12（迁移 16）

不擅自开真机 Codex / 全网搜索。补 origin 角色、研究/任务隐私、恢复后安全默认。

### 本批内容

- origin 增加 `research` / `assistant_suggestion`；助手建议不能写成用户目标或偏好。
- 研究发现写入 open_loop（origin=research），总览目标只收 origin=user。
- 研究公开描述不含私人语句；任务背景排除未分享 personal。
- 恢复后关闭研究自动检查、撤销编码批准，不复用执行授权。

### 自动化

- 新增 `packages/core/test/integration/s6-roles-privacy.test.ts`。
- T01–T05 仍未完成。不得写成全部验收通过。

## 2026-09-09 · ChatGPT 官方导出（未脱敏，仅结构）

用户提供桌面官方导出目录（未脱敏）。**正文未读入仓库、未复制、未提交。**

### 结构事实（计数，无正文）

- `conversations.json` 约 18.5MiB，34 段对话，全部有 `conversation_id` / `current_node`
- mapping 节点 1879，**全部没有 `children` 字段**，只有 `parent`
- 内容类型：text 860、thoughts 634、reasoning_recap 337、multimodal_text 14
- 102 个 `file_*.dat` 附件；不解析、不声称已理解
- `user.json` 含邮箱等身份字段，未使用

### 代码

- 解析器：缺 `children` 时从 `parent` 反推树；`thoughts`/`reasoning_recap` 不当正文
- 合成回归：`s2-import.test.ts`「官方导出缺 children」
- 真实包内存计数：34 来源、866 可见段（user 354 / assistant 512）、7 个未解析附件、0 崩溃

### 未完成

- 未把该包导入用户 IXAEON 数据目录（需你在应用内选择导入）
- Gemini/Grok/Claude 仍无脱敏样本
- T01 真人理解、T02 网页采集未做

## 2026-09-10 · 删除项目

项目页补「删除」。来源改为未归属（原文保留）；该项目的理解、关系、编码任务删除；个人条目保留。需确认对话框。归档仍只是搁置。

## 2026-09-10 · 来源多选删除与项目下拉刷新

- 来源表可多选，确认后批量删除（逐条失败隔离）。
- 项目列表在切到来源/问答等页时重新拉取；新建项目后下拉能看到。
- 已选项目被删除则过滤器回到「全部项目」。

## 2026-09-10 · 启动自动检查更新并弹窗

生产构建打开后约 3 秒检查 GitHub Releases。有新版本弹窗并自动下载，显示进度；下载完成后由用户点「重启并安装」，不自动重启。失败不打扰，设置页仍可手动检查。

## 2026-09-10 · 发版 0.2.4

包版本 0.2.3 → 0.2.4。含：ChatGPT 官方导出无 children、项目删除、来源多选删除、项目下拉刷新、启动更新弹窗。V0.3 真实验收 T01–T05 仍未完成，本号不是 0.3.0。

## 2026-09-10 · 提取失败人话 + 自动再跑一轮

无效引用改为说明哪几条对不上原文；同一来源自动再提取一次，仍失败才取消写入。旧理解保持不变。

## 2026-09-10 · 来源归档 + 短经验摘要（迁移 17）

过往工作可归档：停自动分析、退出待讨论与现行理解；原文可检索。归档时留下一句经验摘要（origin=ai，不是用户目标）。无营养问答仍删除。

## 2026-09-10 · 研究出门说法选填；真机 Codex 按确认默认开启

- 公开描述改为选填：当前抓取不会带出门。
- 用户确认隔离默认后：找到 Codex CLI 则真机派发（workspace-write、隔离工作区、忽略用户更宽配置）；找不到则 Fake。接受结果仍不自动合并/部署。T04 真机小任务验收未完成。

## 2026-09-10 · 开发过程补记；研究发现可加来源、可标值得行动

把 0.2.4 之后的提交写进 `REVIEW_PACKET.md` §24。研究页可再批准 HTTPS 来源；发现可标「值得行动」，出现在个人总览，不自动变成用户目标。出门说法契约改为可空。T01–T05 仍未完成。

## 2026-09-10 · 发现可开编码草案；真网探测

标过值得行动的发现可开编码草案（不批准、不派发，同一发现同一项目幂等）。本机 Codex CLI 0.130.0-alpha.5 仍在。PowerShell 打开 `example.com` HTTP 200；产品用的 Node `fetch` 同机 TLS `ECONNRESET`。T03/T04 日用闭环未跑完。

## 2026-09-10 · 编码任务可删除；卡片标明 Fake/Codex

用户日用库一条「写 note.txt」是 Fake（executor_name=fake），不是真机 Codex。0.2.4 安装包仍走 Fake。任务页补删除（执行中先取消），并写明当前执行器。T04 真机仍未跑。

## 2026-09-10 · 研究抓取走 Chromium；扩展随包；0.2.5

本机 Clash fake-ip 把 `example.com` 解析到 `198.18.0.173`，Node `fetch` TLS 失败。桌面研究改 `electron.net.fetch`。扩展打进 extraResources，启动同步到 userData/extension，设置页给出加载路径和配对码。T01：日用库已有 chatgpt_export 30 条（多数未分析）；chatgpt_web 仍为 0。T02 产品路径已齐，真机采集待用户。不是 0.3.0。

安装包 `IXAEON-Setup-0.2.5.exe` 122,909,747 字节，SHA-256 `C8825E721DF3C797FD4251E6ED18D5970EE9ACB053209CEA2A331F2E292C92C5`。

## 2026-09-10 · 归档按钮无反应；T02/T03 日用库对照

Electron 渲染进程 `window.prompt` 会立刻空返回，归档被当成取消。改为 `confirm`，空摘要由主进程生成。日用库：chatgpt_web=1（红魔玩PC游戏方式）；研究关注「全能AI工作台」立即检查 succeeded。归档条数仍为 0（0.2.5 的 prompt 缺陷）。

安装包 `IXAEON-Setup-0.2.6.exe` 122,909,794 字节，SHA-256 `D5BB542B0AF6BA68160CDC4A7C732B5511E9135F4863D6AD18BB512CF57E5156`。

## 2026-09-11 · 开发主线重整（文档，不是功能完成）

用户明确要求：过往讨论不是绝对参考，但改变方案必须有证据、更成熟，不能在换 Agent/阶段拆分中遗忘或缩小目标。

新增根目录 `IXAEON_v0.3_重整开发计划_个人Agent内核与Hermes接入.md`（2.0）和 `docs/IXAEON_架构决策记录.md`。当前推荐自有 Core + 首选 Hermes 适配器；记忆自动形成并按情境使用；Markdown/SQLite/LanceDB 分工；真实无 URL 搜索与编码结果验证；经验/Skill 与代码候选接力受控升级。

AGENTS/README 指向新计划；长期路线追加修订；旧 V0.3 计划保留并标历史，旧验收与能力清单注明时效和独立审核缺陷。新计划 B0–B5 和 R01–R15 映射旧 A/T 与 F/RQ，不取消四平台/真实执行等欠项。

本批仅规划和只读资料核实，未改业务代码、未修复虚假成功、未安装 Hermes/索引模型、未调用付费服务、未迁移库或发布。验证限文档格式/链接/差异与计划一致性；真实实现和验收待后续开发。

## 2026-09-12 · B0 止损；B1 受阻于未装 Hermes

独立审核 RQ 失败项已改代码：验证、范围、快照、问答外发、取消、网络/指纹。审核测试 20 通过。任务页去掉无条件 `process.exit(0)`。设置页显示 Hermes 探测结果。

本机无 Hermes、无搜索 API。适配器不假装接通。未发版、未改日用库。B1 真实路径待用户批准安装锁定引擎并配置搜索。

## 2026-09-12 · B2 情境筛选；B3 方向可记；B4 失败进工作记录

总览「需要你拍板」不再把全部未确认提取当作业。问答无关问题不硬塞个人目标；相关目标仍可召回。研究关注允许空来源，立即检查失败且 searchUsed=false。编码失败写入 work_runs，下次问答可读。

仍缺：真 Hermes、真搜索、真项目副本、Skill 对照、四平台样本、安装/旧库。不是全部验收通过。

## 2026-09-12 · 桌面问答接 Core 有界循环；Skill 候选；迁移 18

Ask 页不再只做单轮检索：先探 Hermes，未接通则用已配置模型调用 Core 工具（记忆/证据/项目背景/观察；搜索未配置失败；编码须桌面批准）。运行写入 `runtime_runs`。失败编码自动提案 Skill，无对照评测不能批准，无收益保持未采用；已批准的进入下次派发背景。合成旧库 17→18 幂等。未装 Hermes、未配搜索、未发版、未改日用库。

## 2026-09-12 · 一次性记忆不升格；导出新表；会话可取消

提取把「这次会议/仅本次」类陈述从 goal/constraint 降为 open_loop；问长期计划时不召回。导出 ZIP 含 runtime_runs / skill_candidates；恢复取消 running 会话。Core 有界循环支持 cancel，晚到动作不当完成。仍不是真 Hermes / 真搜索 / 安装验收。

## 2026-09-12 · TUI gateway 协议适配（仍非本机 Hermes）

适配器按 [官方 TUI gateway](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration) 的 stdio JSON-RPC：`session.create`、`prompt.submit`、`session.interrupt`、`session.close`。定位只认 `IXAEON_HERMES_EXE` / `IXAEON_HERMES_HOME`，不扫用户 `~/.hermes`。协议替身验证接通与取消；本机未装仍 `NOT_FOUND`。Ask 页增加取消。未发版、未改日用库、未假装 R02 通过。

## 2026-09-12 · 检索降级、查询脱敏、可追溯工作区

LanceDB 适配器在无路径/无嵌入时降级 SQLite 关键词，不下载模型。公开查询本地去掉邮箱、路径、密钥后再报搜索未配置。现有项目副本记录 sha256 与文件数，跳过 `.env`，空目录不能冒充快照。仍不是真 Hermes / 真搜索 / 真项目改写。

## 2026-09-12 · 记忆评测起始集；R13 引擎独立（合成）

§9.1 起始门槛落地：60 个平衡场景（相关召回/无关/一次性/否定纠正/跨项目/权限各 10），确定性子集（检索选择器、降格、权限、纠正链）全部通过；已知词法限制（健身↔马拉松无重叠、「计划」词法噪音）如实记录在报告里。≥90%/95% 模型门槛未跑，不冒充。R13：停 Hermes 后 Core 问答/记账/导出仍可用，重开库纠正仍生效（合成）。真 Hermes、真搜索、四平台样本仍缺。

## 2026-09-12（晚）· 用户批准后：锁定 Hermes 安装 + 三项真机探针

用户批准（一次说明范围）：官方安装器装锁定版 Hermes 到专属目录、Codex 额度跑隔离文件探针、日用库只做副本迁移。执行结果：

1. **锁定安装**：官方 install.ps1 `-Tag v2026.9.11`（=0.21.2，commit 939e45c91d）→ `D:\Software\IXAEON\Hermes` 专属目录；-SkipSetup/-SkipComputerUse/-NonInteractive。uv.lock 哈希校验失败回退 PyPI 解析、ffmpeg 走 winget、58 个随包技能同步——全部如实记入 runtime-lock.json。不碰用户 ~/.hermes（本机不存在）。
2. **R02 真 stdio 网关**（r02-real-hermes-gateway.test.ts，IXAEON_REAL_HERMES=1）：按官方 TUI 客户端同款启动（venv python -u -m tui_gateway.entry，cwd/PYTHONPATH=仓库根，HERMES_HOME）——gateway.ready → session.create 返回 session_id → session.close。事件帧核实为 method='event'+params.type。**无 provider 时整回合 52 秒诚实失败**（不假成功、不挂死）。适配器按真实协议重写（prompt.submit 用 text、message.complete 带 status、tool.start 用 tool_id）。
3. **T04 真 Codex 文件探针**（t04-real-codex.test.ts，IXAEON_REAL_CODEX=1）：真 codex 在隔离工作区写 note.txt → 独立验证命令通过 → 磁盘复核。途中发现并修复两个真缺陷：执行器通道文件被范围守卫误判越界（改为不计入交付物）；`--ignore-user-config` 在 Windows 丢 `[windows] sandbox="elevated"` 导致只读（显式 `-c windows.sandbox="elevated"` 补回）；elevated 沙箱下 codex 进程在 turn.completed 后不退出（以协议终点+10s 宽限+杀树收尾）。每日假成功证据的「只读模式」根因即此。
4. **R15 日用库副本**（r15-real-daily-db-copy.test.ts）：真实库副本 17→18 幂等迁移、数据保全（40 sources/870 segments/75 items/1 project——比 9-11 快照多出的 2 源/7 段/18 条为当日研究导入，如实记录）、源库 SHA256 前后一致。

仍未做：真模型回答（需 provider 凭证）、Core 工具 MCP 桥接（需 provider 先通）、真实搜索（需服务）、四平台样本（需用户提供）。

## 2026-09-13 · provider 配置后：真模型回合 + MCP 工具桥（B1 闭环）

用户以方式 A 配置 provider（custom → 自建 OpenAI 兼容网关，gemini-3.7-flash-tiered）。随后：

1. **R02 升级为真模型断言**：prompt.submit → message.complete → terminal + 回答非空（`hermes -z` 冒烟 + r02 探针 11s 通过）。无凭证阶段的诚实失败证据保留在 2026-09-12 记录。
2. **apps/mcp 双后端**：新增直连模式（IXAEON_MCP_DB_PATH → 进程内 McpService，不经桌面端 HTTP）。途中修了打包问题：better-sqlite3 是原生 CJS，打进 ESM bundle 会 require 报错 → external + 声明依赖；workspace 源码包必须打进 bundle。HTTP 转发模式（localToken）保持不变，日用链路权限边界不变。
3. **网关审批策略**：approval.request 现按会话 allowedTools 白名单匹配负载文本，命中放行一次（choice=once），否则明确 deny——不放行未授权操作，也不挂死等 5 分钟超时。
4. **R16 Core↔Hermes MCP 工具桥真机通过**（20s）：mcp_servers.ixaeon（直连合成库）→ Hermes 会话自动发现 4 个工具 → 真模型调 search_context → 回答引用种子目标「在花园里种九棵蓝莓」。三个诚实断言：tool_request 含 search_context、terminal、回答含种子关键词。探针后 Hermes 配置自动还原（mcp_servers 移除，备份恢复）。
5. 途中两个真实坑记录：`hermes mcp add --args` 是贪婪参数（--env 必须放前面）；CLI 交互提示读 EOF 会崩（测试里显式喂 stdin）。

B1 至此具备完整证据链：真握手、真模型回答、真工具桥。剩余：真实搜索服务（B3 主线缺口）与日用库接入桥（需用户明示）。

## 2026-09-13（续）· B3 受控搜索接线 + 四平台样本口径变更

用户明确：① 要 Brave/Tavily key 输入方式；② 四平台样本不再索取——只有 ChatGPT，导入能力做好后随用随填。

1. **搜索执行器**（`packages/core/src/research/webSearch.ts`）：Brave（X-Subscription-Token）与 Tavily（Bearer）双 provider，统一归一化命中；网络/401/429/解析失败全部诚实抛 IXA0017，不造结果。测试注入 fetchFn。
2. **broker 接线**：`search_web` 先本地脱敏（不变），配置了执行器才外发，回传 {provider, redacted, reasons, hits}；未配置仍诚实失败（旧契约不变，`b3-websearch.test.ts` 5/5）。
3. **设置页输入路径**：新增「网页搜索（研究用）」卡片——provider 下拉（none/brave/tavily）+ Key 输入（safeStorage 加密落盘，不回显）+ 「测试搜索」真实查询一次。config.json 新增 webSearch 段（旧配置文件兼容：zod default）。安全静态扫描的出口白名单**显式**加入两个搜索域名（注释说明），「未声明出口=禁止」不变。
4. **真机探针就位**：`b3-real-search.test.ts`（IXAEON_REAL_SEARCH=1 + provider + key）断言真实 http(s) 命中。**尚未跑**——等用户在设置页存好 Key 后由我执行。
5. **B5 口径**：四平台导入器按公开导出格式实现 + 合成数据验证；真实数据（Gemini/Grok/Claude）用户日后自填，不再作为验收前置。导入器本身尚未实现（下一批）。

B3 剩余（下一批）：研究检查循环接 search_web（searchUsed 标志与发现落库）、真机探针执行、Research 页 searchConfigured 展示。
