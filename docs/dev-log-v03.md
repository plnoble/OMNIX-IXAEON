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
