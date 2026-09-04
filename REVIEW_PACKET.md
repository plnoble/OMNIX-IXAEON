# IXAEON v0.1 审核材料（REVIEW_PACKET）

> 按 `IXAEON_v0.1_开发计划.md` 第 12 章要求交付，并逐项回应
> `IXAEON_v0.1_验收问题与修复任务.md`（验收基线）。
> 生成时间：2026-09-05。仓库：`D:\Agent\Project\OMNIX-IXAEON析衍`（分支 `main`）
>
> **声明**：本文件严格区分「自动化已验证 / 人工已验证 / 尚未验证 / 已知限制」。
> 每项声明附可复现命令或测试名。

---

## 0. 验收问题修复总览（对修复任务文档逐项）

| 问题 | 修复 | 回归测试 | 状态 |
|---|---|---|---|
| P1-3 安装版/开发版 MCP 配置不可用 | MCP 入口随包携带（extraResources → `resources/mcp/index.mjs`）；命令 = IXAEON.exe 自身（`ELECTRON_RUN_AS_NODE=1`），零全局 Node 依赖；开发版从 exe 位置向上实查 `apps/mcp/dist/index.mjs`（存在性校验） | desktop e2e「MCP 片段命令真实握手」从 win-unpacked 产物完成真实 STDIO initialize + tools/list | ✅ 自动化已验证 |
| P1-4 问答/MCP 全文搜索失效 + 越过项目边界 | FTS 连接改 `sg.rowid = f.rowid`（askStore / mcpStore）；指定项目仅返回 `project_id` 严格相等资料（未分配不混入）；全局检索含未分配（规则记录于 privacy-model.md）；撤销授权来源不进任何检索；prepare_task 预算按序列化 JSON 长度核算 | `fixes.test.ts`（FTS 原文检索 / A·B·未分配三向隔离 / 特殊字符不炸 SQL）+ mcp.test.ts | ✅ 自动化已验证 |
| P1-5 渲染层可自伪造授权 | 契约层删除 `allowedPaths`；改为**一次性授权票据**（pickFiles/pickSaveZip/pickRestoreZip 签发，5 分钟有效、单次使用、用途绑定）；核心层 ImportService 不再自行授权，必须传主进程创建的 permissionId（realpath 范围校验）；撤销后 8 个读取入口统一拒绝（阅读/上下文/搜索/问答/MCP segment 路径/MCP item 路径/重提取/vault 读取） | `fixes.test.ts`（伪造票据/A 授权读 B/符号链接逃逸/撤销全入口）+ desktop e2e「渲染层伪造路径导入被拒绝」 | ✅ 自动化已验证 |
| P1-6 采集闭环不完整 | `onCaptured` 接入（autoAnalyze=true 且域授权有效才排队，60s 防抖 + 任务表去重）；popup 新增「暂停/继续当前对话」（扩展本地拦截 + 服务端 403 双重强制）；`page:<hash>` → `/c/<id>` 身份合并（单一来源、不重复不丢内容）；同轮新指纹旧版转 `is_active_branch=0`；每次追加刷新 imported_at | `localServer.test.ts` 9 项 + 扩展 e2e 暂停场景 | ✅ 自动化已验证 |
| P1-7 导出不可读 + 恢复风险 | 导出增加 `data/*.json` 8 份人类可读文件（格式版本 + 稳定字段名）；恢复 = 临时目录全量校验（SQLite 头 / integrity / 迁移兼容 / raw_path 严格格式 + 布局一致 + vault 文件存在）→ 备份 rename（失败即中止，不吞异常）→ 原子替换 → 失败回滚；恢复必须持有 previewRestore 签发的一次性 previewToken | `archiveFixes.test.ts` 8 项（凭证伪造/重复、恶意 raw_path、zip slip、未知条目、数据等价、备份失败回滚） | ✅ 自动化已验证 |
| P1-8 自定义数据目录丢设置 | completeSetup 重构：先在新目录写全部数据（config 含加密 Key + localToken + 建库 + 首个项目）→ 全部成功后才切 bootstrap 指针；失败旧指针不动；API Key 仍走 safeStorage | 见已知限制 11.3（自动化覆盖核心层；完整 e2e 见下） | ✅ 自动化已验证（部分人工见 11.3） |
| P1-9 日志保留正文 2000 字符 | 白名单式清洗：正文键（text/content/prompt/…/error/file 等 28 个）→ 仅长度+SHA-256 摘要；敏感键（token/apikey/…）同样摘要；Error/cause/message 递归；普通字符串上限 300；debug 级别同样清洗 | security.test.ts（开头/中间/结尾 + 独特短语全断言不存在）+ paths.test.ts | ✅ 自动化已验证 |
| P1-10 重提先删旧理解 + 分块不限长 | 提取改为「全部模型块成功 → 单短事务原子替换」；任一块失败旧 current 理解不变；Markdown/TXT 按标题/段落拆 segment（>6000 字符段继续安全切分）；单块完整 user 文本 ≤8000（含编号头）；splitTextToFit 保证可重组 | `fixes.test.ts`（首块失败旧理解保留 / 原子替换 + superseded 不丢 / 30000 字符单段多块 / 多标题拆分 / 重组完整性） | ✅ 自动化已验证 |
| P2-11 材料缺口 | 真实文档语义验收（两份思想文档导入 + 六组问题检索 + 引用）；生成 `ixaeon-export-sample.zip`；12 张真实截图；端口 43120→43191 修正；本文件逐项标注验证方式 | `semanticAcceptance.test.ts` + screenshots.spec.ts + 扩展 e2e 截图 | ✅ 自动化已验证（真实模型问答除外，见 11.4） |

---

## 1. 完成范围

### 实际完成（M0 → M5 全部 + 验收修复）

| 里程碑 | 范围 | 状态 | Commit |
| --- | --- | --- | --- |
| M0 | monorepo 骨架（contracts / core / test-fixtures / desktop / mcp / extension）、SQLite migration、日志、错误码、verify 脚本 | ✅ | `2708585` |
| M1 | 原文仓库（vault + SHA-256）、导入、权限、桌面应用全页面、e2e 冒烟 | ✅ | `c113247` |
| M2 | ModelProvider、OpenAI Responses 客户端、结构化提取、项目卡、纠正、Inbox、问答 | ✅ | `214a255` |
| M3 | MCP 闭环（4 工具 + 本地端点 + STDIO 转发 + 配置文档） | ✅ | `5d970ae` |
| M4 | ChatGPT 网页扩展（增量采集 + 配对 + 流式稳定） | ✅ | `810038d` |
| M5 | 导出/恢复、安全/性能验证、NSIS 安装包、首版 REVIEW_PACKET | ✅ | `21376ed` |
| 修复 | 本轮验收问题修复（P1×8 + P2-11），见第 0 节 | ✅ | （本次提交） |

### 明确未完成 / 降级说明（如实）

- **真实模型语义验收问答**：自动化部分用真实文档 + 检索引擎验证可检索性与引用；
  带真实 OpenAI 模型的六问六答需用户配置 API Key 后人工执行（见 11.4，含操作步骤）。
- **ChatGPT 真实网页人工验收**：扩展 e2e 覆盖 mock chatgpt.com 全流程；真实 chatgpt.com
  页面的人工测试（10 秒内可见、刷新不重复、暂停不采集）需要用户登录态，见 11.5。
- **Claude/Gemini/Grok 导入器、主聊天窗、早报、NAS、手机**：不在 v0.1（计划 13 章）。
- **Firefox 扩展**：不在 v0.1（计划范围即 Chrome/Edge）。
- **恢复后自动重启**：提示用户手动重启（不强制 relaunch）。

---

## 2. 架构与数据流

```
用户文件/ChatGPT 导出 ──原生对话框（一次性票据）──▶ 主进程授权（grantFile/grantFolder）
    │                                              │
    ▼                                              ▼
vault/（sha256/xx/hash 原件，永不回收）    SQLite（WAL + 外键 + FTS5 trigram）
    │                                        ├─ segments（标题/段落分片 + 活动分支标记）
    │                                        ├─ sources（raw_path 严格格式 + permission_id）
    │                                        ├─ items / item_evidence（结论 + S 段证据）
    │                                        ├─ corrections（改口历史）
    │                                        └─ permissions / work_runs / audit_events
    │                    ModelProvider（OpenAI Responses / FakeProvider 测试）
    │                        提取：全部块成功 → 单事务原子替换旧 current 理解
    ▼
浏览器扩展（chatgpt.com）──pair 码──▶ 桌面本地 HTTP（127.0.0.1:43191）
    │  内容脚本：仅可见轮次 + 2s 稳定 + 本地暂停拦截     │（Bearer：extension / local token）
    │  暂停当前对话（popup 按钮，本地+服务端双强制）      ├─ /api/extension/*（autoAnalyze 回调）
    └──────────────────────────────────────────────────┤
                                                       ├─ /api/mcp/*（4 工具，localToken）
                                                       │      ▲ STDIO JSON-RPC
                                                       │      └ resources/mcp/index.mjs
                                                       │         （IXAEON.exe ELECTRON_RUN_AS_NODE=1 运行）
                                                       ▼
                              导出（data/*.json 人类可读 + db 副本 + vault/）
                              恢复（previewToken → staging 全量校验 → 备份 → 原子替换 → 失败回滚）
```

关键不变式（全部有测试兜底）：

1. **原文永不破坏**：vault 内容寻址、只增不删；纠正生成新 item 而非改写。
2. **权限最小且不可伪造**：读取必须追溯到原生对话框票据或持续授权记录；核心层
   不接受调用方自报路径；撤销后 8 个入口行为一致。
3. **可追溯**：每条结论必须有 item_evidence；无效引用整批拒绝；引用可打开原文。
4. **幂等**：同内容重复导入/采集不重复；同轮新指纹保留旧版为非活动分支。
5. **失败不丢数据**：模型失败旧理解不变；恢复失败原数据可用；备份失败中止不覆盖。
6. **项目隔离**：指定项目只返回明确归属资料；未分配绝不自动混入项目上下文。

---

## 3. Git commit 列表

```
2708585 M0: 项目骨架与基础设施（contracts / core / desktop / mcp / extension）
c113247 M1: 导入与桌面应用（UI 全功能 + e2e 冒烟）
214a255 M2: 项目卡、提取和纠正（理解引擎 + 问答）
5d970ae M3: MCP 闭环（4 工具 + 本地端点 + 配置文档）
810038d M4: ChatGPT 网页扩展（增量采集 + 配对 + 流式稳定）
21376ed M5: 导出/恢复 + 安全/性能验证 + NSIS 安装包 + REVIEW_PACKET
（本次）fix: 验收问题修复（权限票据 / FTS 隔离 / 原子提取 / 采集闭环 / MCP 打包 / 目录切换 / 导出回滚 / 日志白名单）
```

---

## 4. 验证命令与结果（全部实跑，exit 0）

```
corepack pnpm verify
  ✓ lint（ESLint） 通过（1.9s）
  ✓ format:check（Prettier） 通过（1.4s）
  ✓ typecheck（tsc --noEmit） 通过（3.2s）
  ✓ unit（Vitest） 通过 —— 16 passed
  ✓ integration（Vitest） 通过 —— 97 passed
      db 6 / import 13 / extraction 9 / mcp 10 / archive 11 / security 8 /
      performance 4 / fixes 15（新增）/ archiveFixes 8（新增）/
      semanticAcceptance 4（新增）/ localServer 9（新增）
  ✓ build（desktop / mcp / extension） 通过

corepack pnpm test:e2e
  desktop e2e：9 passed（Playwright + Electron；含 MCP 真实 STDIO 握手、
              票据伪造拒绝、MCP 端点真实 prepare_task + record_work_result）
  extension e2e：全部断言通过（真实 Chromium + 真实扩展 + mock chatgpt.com；
              含暂停/继续当前对话闭环）

corepack pnpm package:windows
  ✓ mcp build → ✓ desktop build → ✓ electron-builder（NSIS）
  产物：apps/desktop/release/IXAEON-Setup-0.1.0.exe
```

### 安装版 MCP 验收（从 win-unpacked 产物，零系统 Node 依赖）

```
命令：win-unpacked\IXAEON.exe + ELECTRON_RUN_AS_NODE=1 + resources\mcp\index.mjs
结果：
  initialize → serverInfo { name: "ixaeon" } ✅
  tools/list → prepare_task / search_context / get_source_excerpt / record_work_result 全部存在 ✅
  桌面端未运行时 prepare_task → "IXA0017 无法连接 IXAEON 桌面端（http://127.0.0.1:43191）。
                                请确认桌面应用已运行。"（可操作错误）✅
桌面服务运行时（desktop e2e 用例 8）：
  prepare_task("橙子计划") → 200，简报含项目名 ✅
  record_work_result(...) → 200，work_run_id 返回 ✅
  错误令牌 → 401 ✅
```

---

## 5. 六组验收场景证据

### 5.1 数据导入（授权选择 + 票据制）

- `import.test.ts`（13 项）：未授权拒绝（PERMISSION_DENIED，核心层现在校验
  permissionId 存在性 + 路径范围）；重复导入幂等；conversations.json 活动分支保留。
- `fixes.test.ts`：伪造授权 ID 拒绝；A 文件授权读同目录 B 文件拒绝（PATH_ESCAPE）；
  目录授权 + 符号链接逃逸拒绝（realpath）；敏感文件（.env）拒绝。
- desktop e2e：渲染层直接伪造票据 importPaths →「票据无效或已使用」。
- 恶意 ZIP：`archiveFixes.test.ts`（vault/../ 条目、evil.exe 未知条目、恶意 raw_path
  均在替换前拒绝，且不写出任何越界文件）。

### 5.2 项目卡（提取 + 纠正 + 改口历史）

- `extraction.test.ts`（9 项）+ `fixes.test.ts` 提取组（6 项）：
  - 有效 S 段引用入库、无效引用整批拒绝、prompt_version 记录
  - **首块模型失败 → 旧 current 理解保持不变**（修复 P1-10 核心断言）
  - **全部成功 → 单事务原子替换**；用户纠正（superseded）与历史不丢
  - 30,000 字符单段：每个模型请求完整 user 文本 ≤8000；多标题文档按标题拆分且
    引用可打开原文（getSegmentContext）；vault 原文逐字保留
  - splitTextToFit：分块不超限且 join 后与原文完全一致

### 5.3 MCP 闭环

- `mcp.test.ts`（10 项）：三种项目引用、简报分组 + 引用 + 序列化预算 + 过期提醒、
  搜索（项目隔离 + 授权过滤）、摘录（segment 与 item 两路权限一致）、
  record_work_result 事务、最近工作集成。
- **安装版真实握手**：第 4 节（win-unpacked + ELECTRON_RUN_AS_NODE）。
- **桌面运行时真实调用**：desktop e2e 用例 7/8（prepare_task + record_work_result
  通过 127.0.0.1:43191 + localToken 完成）。
- 配置片段：设置页生成，命令 = IXAEON.exe、args = [resources/mcp/index.mjs]、
  env = ELECTRON_RUN_AS_NODE=1 + IXAEON_LOCAL_TOKEN（令牌不进命令行/日志）。

### 5.4 网页采集（含修复 P1-6 闭环）

- `localServer.test.ts`（9 项）：
  - autoAnalyze=false：采集成功、原文落库、模型回调 0 次
  - autoAnalyze=true：新内容触发提取回调；重复批次不重复回调（防抖）
  - 暂停对话 A → A 被拒（403 IXA0022），对话 B 正常提交；A 内容未入库
  - 全局暂停：全部拒绝
  - page:<hash> → /c/<id> 身份合并：单一来源、3 轮内容不丢
  - 重新生成：旧版 is_active_branch=0 保留、新版唯一活动
  - imported_at 每次成功追加都刷新
  - 错误令牌 401；localToken 可调 MCP 端点、扩展令牌不可
- 扩展 e2e（真实 Chromium + 扩展加载）：配对 / 稳定提交 / 流式 / **暂停当前对话
  （popup 按钮 → 本地拦截 + 服务端同步 → 恢复后继续上传）** / 未配对 / 非 chatgpt.com
  页面零采集。

### 5.5 权限与攻击

- `security.test.ts`（8 项）：
  - 提示注入文本只作为资料片段（[R1] 引用，不执行）
  - 未授权路径拒绝；.env 拒绝
  - **日志**：API Key/token/password/Bearer 全遮盖；27,000 字符正文的**开头、中间、
    结尾标记与独特短语全部不出现**（不只断言完整串不存在）；Error/cause/响应体
    同样只留摘要；debug 级别同样清洗
  - 无外联静态扫描（127.0.0.1 / localhost / api.openai.com 之外无目标）
- `fixes.test.ts` 日志组：file/error/text 键均为摘要形态。
- vault 严格路径：`sha256/[0-9a-f]{2}/[0-9a-f]{64}` 严格正则 + resolve 后必须位于
  vault 根内（`Vault.isStrictVaultRelPath` + `absolutePath` 双重校验）。

### 5.6 数据所有权（导出/恢复）

- `archive.test.ts`（11 项）+ `archiveFixes.test.ts`（8 项）：
  - 导出 ZIP = manifest + readme + **data/*.json 8 份人类可读** + db.sqlite + vault/
  - 人类可读 JSON：不依赖 IXAEON 可读，带 formatVersion 与稳定字段名（测试断言
    打开 ZIP 即可解析 projects/sources/segments/items/item-evidence/corrections/
    work-runs/permissions 八份）
  - 恢复：previewToken 一次性凭证（伪造/重复/未预览均拒绝）；staging 全量校验；
    备份 rename 失败立即中止；**恢复后七表数据与原文逐字节一致**；备份阶段失败
    旧数据保持可用
  - 恶意包：raw_path 穿越/错误哈希/布局不一致、vault ../ 条目、未知条目全部
    替换前拒绝；目标目录不留半个新库
- 导出样例：`apps/desktop/release/ixaeon-export-sample.zip`（真实生成，含两份
  思想文档的完整数据，可解开直接阅读 JSON 与 vault 原文）。

---

## 6. 截图（真实渲染，非 DOM 断言替代）

`apps/desktop/release/screenshots/`（全部由 e2e 真实截图）：

| 文件 | 内容 |
|---|---|
| 01-setup.png | 首次设置向导（数据目录步骤） |
| 02-sources.png | 来源页（导入后列表） |
| 03-source-detail.png | 来源详情（片段阅读器） |
| 04-search.png | 检索页（命中结果） |
| 05-projects.png | 项目页 |
| 06-understanding.png | 理解页 |
| 07-ask.png | 问答页 |
| 08-settings.png | 设置页（模型 / 采集开关 / MCP 片段 / 导出恢复） |
| 09-overview.png | 总览（服务 127.0.0.1:43191） |
| 10-extension-pair.png | 扩展弹窗（配对输入） |
| 11-extension-connected.png | 扩展弹窗（已配对 + 状态） |
| 12-extension-paused.png | 扩展弹窗（当前对话已暂停 + 继续按钮） |

---

## 7. 网络请求目标清单（全部）

| 目标 | 用途 | 何时发生 |
| --- | --- | --- |
| `https://api.openai.com/v1/responses` | OpenAI Responses 模型调用 | 仅用户配置 API Key 并触发提取/问答 |
| `127.0.0.1:43191`（本地回环） | 扩展 ↔ 桌面端、MCP ↔ 桌面端 | 本机进程间 |
| 无其他目标 | — | 静态扫描测试强制（security.test.ts） |

- 扩展只访问 chatgpt.com DOM + 127.0.0.1；MCP 只访问 127.0.0.1。
- 无遥测、无更新检查（publish: null）、无崩溃上报。
- （修正说明：旧版 REVIEW_PACKET 两处误写端口 43120，实际固定端口为 **43191**。）

---

## 8. 依赖与许可证

| 依赖 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| electron | 44.1.1 | MIT | 桌面壳（兼作 MCP 的 Node 运行时） |
| react / react-dom | 19.2.x | MIT | 渲染层 |
| vite / electron-vite / @vitejs/plugin-react | 7 / 5 / 5 | MIT | 构建 |
| better-sqlite3 | 13.0.3 | MIT | 存储（N-API） |
| fastify | 5.12.1 | MIT | 本地 HTTP |
| jszip | 3.10.1 | MIT/Apache-2.0 | 导出/恢复 |
| zod | 4.5.4 | MIT | 契约校验 |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | MCP STDIO |
| playwright / @playwright/test | 1.62.1 | Apache-2.0 | e2e |
| vitest | 4.1.11 | MIT | 测试 |
| eslint / prettier / typescript | 见 lockfile | MIT | 工具链 |

（全部宽松许可；无 AGPL/商业组件。）

---

## 9. 三份历史文档未修改证明

```
git log --oneline -- JARVIS_CONSTITUTION_v0.1.md Jarvis_Constitution_v0.1.docx grok-20260903-IXAEON-思想碰撞.md
→ 2708585 M0: 项目骨架与基础设施（仅初始加入，此后无任何提交）

git diff HEAD -- <三份文档> → 空（工作区亦无改动）
```

三份文档在 `.prettierignore` 中显式排除（连同两份验收基线文档），格式化不会触碰。

---

## 10. 干净环境命令

```text
pnpm install --frozen-lockfile
pnpm verify
pnpm dev
pnpm build
pnpm package:windows   # 先构建 apps/mcp（打包资源），再 desktop，再 electron-builder
```

修复说明：`package:windows` 现在先执行 `apps/mcp` 的 vite 构建，确保
`resources/mcp/index.mjs`（extraResources）存在；打包脚本剥离 pnpm/corepack 注入的
环境变量（否则 electron-builder 的 node-module 收集器在 pnpm 子进程中解析被污染的
`pnpm list --json` 输出会失败）。

---

## 11. 已知问题、风险与未验证事项（如实）

1. **扩展 e2e 依赖本地 Chromium 1208**（Playwright 缓存）：系统 Chrome 152 企业策略
   拒绝 `--load-extension`；脚本自动选择可用浏览器。
2. **中文路径 + Chrome 扩展加载**：仓库路径含中文时 Chrome 静默不加载——e2e 自动
   复制到 ASCII 临时目录；用户手动加载建议英文路径。
3. **自定义数据目录完整重启验证**：核心逻辑（新目录全量写入 → 指针最后切换 →
   失败保留旧指针）已由单测级验证；「设置向导选自定义目录 → 重启 → 直接进主界面」
   的完整 e2e 因 e2e 环境用 IXAEON_DATA_DIR 注入（环境变量优先级最高）未覆盖，
   **标记为尚未自动化验证**（用户可按 Setup 向导自测，预期：完成时提示重启）。
   数据目录解析优先级（env > bootstrap > 默认）已有代码注释与实现。
4. **真实模型语义问答**：自动化语义验收覆盖真实文档的导入、分块、检索、引用与
   「资料不足」路径（semanticAcceptance.test.ts）。带真实 OpenAI 模型对六组问题的
   自然语言回答需用户配置 API Key 后在「问答」页执行（推荐问题清单与判据见
   `IXAEON_v0.1_验收问题与修复任务.md` 第 11.6 节）；**标记为尚未人工执行**。
   预期答案未写死进任何生产代码。
5. **ChatGPT 真实网页人工验收**：扩展 e2e 在 mock chatgpt.com 全流程通过；真实
   chatgpt.com（登录态、真实对话、10 秒可见性、刷新不重复）需人工执行——
   **标记为尚未人工执行**（步骤：安装 dist 扩展 → 桌面端配对 → 开启采集 →
   对话 → 观察来源页 → 暂停当前对话 → 观察不再提交）。
6. **导出包含完整 db 副本**（未加密）：v0.1 边界即「本地文件即明文」（设置页已
   声明）；建议 BitLocker。
7. **恢复需重启**：恢复成功后 UI 提示手动重启。
8. **better-sqlite3 原生模块**：随 Electron ABI 重建（postinstall 处理）。
9. **导出 db 中 raw_path 在 Windows 导出为反斜杠形态**：恢复时自动规范化为正斜杠
   并写回（测试覆盖）；不影响数据语义。

---

## 12. 交付物清单

- 源码：本仓库（M0–M5 + 验收修复）
- 安装包：`apps/desktop/release/IXAEON-Setup-0.1.0.exe`
  - 大小：122,562,744 字节（≈116.9 MB）
  - SHA-256：`9569DF834855CCF9D2CD21694D7CBE79BE1609F9345F5371A1E820272071BA04`
  - 随包携带 `resources/mcp/index.mjs`（已验证存在于 win-unpacked）
- 导出样例：`apps/desktop/release/ixaeon-export-sample.zip`（含两份思想文档真实数据）
- 语义验收记录：`apps/desktop/release/semantic-acceptance.json`
- 截图：`apps/desktop/release/screenshots/`（12 张）
- 审核材料：本文件
- 配置文档：`docs/mcp-setup.md`（Codex / Claude Code / Cursor）
- 开发过程记录：`docs/dev-log-fixes.md`（本轮修复）

---

## 附录：打包环境网络说明

同前版（Electron 镜像 / NSIS 手动缓存方案），干净网络环境无需以上步骤。
