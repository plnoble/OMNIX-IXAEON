# 开发过程记录：IXAEON v0.1 验收问题修复

> 任务来源：`IXAEON_v0.1_验收问题与修复任务.md`（2026-09-04 审核，v0.1 暂不通过验收）
> 修复执行：2026-09-04 ~ 2026-09-05
> 修复顺序按任务文档第 12 节：权限边界 → FTS 隔离 → 提取事务/分块 → 采集闭环 →
> MCP 打包 → 数据目录 → 导出恢复 → 日志隐私 → E2E/材料。

---

## 一、问题定位阶段（先读代码再动手）

审核前通读了关键路径的实现，确认审核意见全部属实：

1. `askStore.ts` / `mcpStore.ts` 的 FTS 连接写的是 `JOIN segments s ON s.id = f.rowid`
   ——`segments.id` 是 UUID 文本、`f.rowid` 是数字行号，恒不相等 → 全文检索恒 0 命中。
2. `ipc.ts` 的 `importPaths` 把渲染层传入的 `input.paths` 原样当作 `allowedPaths`
   （自授权）；`registerProjectDirectory` 同样直接信任 `rootPath`。
3. `Extractor.extractSource()` 在任何模型调用前先 `deleteOldAiItems()`；`buildBlocks`
   只在「已有内容」时检查上限，单个 30k 字符 segment 会整段进入标称 8k 的块。
4. `LocalServer` 构造时 `onCaptured` 从未传入；`appendCapturedTurns` 对同顺序新指纹
   只插入不降级旧版本；`lastCaptureAt` 读 `imported_at` 但追加时不刷新。
5. `electron-builder.yml` 没有 extraResources；`mcpSnippet` 的开发模式路径推算会
   解析到 `node_modules/.pnpm/electron@44.1.1/apps/mcp/dist/index.mjs`（不存在），
   命令写死 `node`。
6. `ArchiveService.restoreData` 的备份 rename 用 `.catch(() => {})` 吞掉失败；
   `Vault.absolutePath` 只查 `sha256/` 前缀。
7. `completeSetup` 只写 bootstrap.json 指针，本进程继续往旧目录写 setupComplete/
   模型配置/首个项目 → 重启后新目录是空的，用户再见首次设置。
8. `logger.ts` 普通字符串只截断 2000 字符 —— 27k 正文的前 2000 字符会落日志；
   现有测试只断言「完整串不存在」。

---

## 二、修复实施（按顺序）

### 1. 权限边界、撤销语义和 Vault 路径安全（P1-5）

**契约层（packages/contracts/src/ipc.ts）**：删除 `importPathsInputSchema.paths`
（渲染层自报路径的通道）；新增 `pickResultSchema`（一次性票据 + 对话框返回的路径）、
`importPickedInputSchema`（只收票据）、`exportDataInputSchema` / `restoreDataInputSchema`
（导出目标与恢复来源同样票据化）；恢复预览新增 `previewToken` 字段。

**核心层（access.ts 新文件 + importService.ts 重写）**：
- 新建 `assertSourceAuthorized` / `assertSegmentAuthorized` / `isSourceAuthorized`：
  撤销授权的统一读取边界，八个入口（getSegments / getSegmentContext /
  searchSegments / 问答上下文 / MCP segment 路径 / MCP item 路径 / 重新提取 /
  rawContent）全部接入。
- ImportService 删除 `allowedPaths` 参数与内部 `grantFile` 调用：核心层不再创建
  授权，调用方必须传可信主进程创建的 `permissionId`；`requirePermission` 校验
  授权存在、active、且 realpath 后覆盖请求路径（folder 前缀 / file 精确）。

**主进程（ipc.ts 重写）**：票据表（`Map<ticket, {paths, realPaths, purpose, expiresAt}>`）
- `pickFiles` / `pickSaveZip` / `pickRestoreZip` 弹原生对话框后签发票据（随机 24 字节
  hex，5 分钟有效）；测试钩子 `IXAEON_TEST_DIALOG_RESPONSES` 同样走签发。
- `importPaths` 消费票据（用途必须 import）→ 主进程 `grantFile` → 带 permissionId
  调核心层；单个文件失败进 `failed[]` 不阻塞其余。
- `consumeTicket` 一次性：验证后立即删除（无论后续成败），伪造/过期/重复/用途
  不符全部 PERMISSION_DENIED。

**Vault（vault.ts）**：`absolutePath` 严格正则
`^sha256/[0-9a-f]{2}/[0-9a-f]{64}$` + resolve 后必须仍在 vault 根内；
新增静态 `isStrictVaultRelPath` 供恢复校验复用。

### 2. FTS 搜索与项目隔离（P1-4）

- `askStore.ts`：FTS 连接改 `sg.rowid = f.rowid`；指定项目时 `seg.project_id !==
  projectId` 一律跳过（未分配不混入）；撤销来源不进上下文；条目依据片段也做
  项目归属 + 授权双检（无权依据只留条目陈述，不带原文摘录）。
- `mcpStore.ts`：同修复；`search_context` 指定项目改为 `src.project_id = ?`
  （原来是 `= ? OR IS NULL` —— 未分配混入的根源）；get_source_excerpt 的 item 路径
  补上与 segment 路径一致的授权断言（旁路封堵）；prepare_task 预算改按
  `JSON.stringify(entry).length` 核算（保证序列化输出不超 max_chars）。
- `search.ts`：FTS/LIKE 两条路径都过滤撤销来源；trigram 词长阈值从 2 提到 3
  （2 字中文词走 LIKE 兜底，修复「析衍」检索不到）。
- 隔离规则写入 `docs/privacy-model.md`「项目隔离与全局检索」。

### 3. 提取事务与长文分块（P1-10）

- `extractor.ts` 重构：模型调用全部在前（不持锁），成功后在**单个事务**里
  「删旧 current + 写新 + 冲突标记」；任一块失败直接抛出，旧理解不动。
  授权撤销的来源拒绝重新提取。
- `buildBlocks`：超长单段先 `splitTextToFit`（段落/句/标点/空白安全边界，兜底硬切）
  拆成 `S1 / S1.2 / S1.3…` 子引用；块内多段拼接后整块 user 文本 ≤8000（含编号头）。
- `parsers.ts`：Markdown/TXT 按标题 + 空行段落拆 segment（>6000 字符段继续切），
  heading 存 metadata；vault 原件逐字不变（contentHash 仍按全文）。

### 4. ChatGPT 自动分析、对话暂停和版本管理（P1-6）

- `localServer.ts`：构造参数接入 `onCaptured`；`maybeAutoAnalyze`（采集开启 +
  autoAnalyze=true + 域授权有效 + 本批有新内容 + 60s 防抖）回调 AppRuntime；
  新端点 `GET /api/extension/paused`、`POST /api/extension/pause-conversation`；
  capture 处理器对暂停对话返回 403 IXA0022（服务端强制）。
- 身份合并：正式 `/c/<id>` 批次到达而库里只有 `page:<hash>` 临时来源时，先建正式
  来源（沿用授权），再 `mergeConversationSources`（按 external_node_id+content_hash
  幂等搬运，item_evidence 转挂，删临时来源行）。
- `sourceStore.appendCapturedTurns`：同顺序新指纹 → 旧版本 `is_active_branch=0`；
  旧指纹回归（编辑回退）→ 重新激活并降级其他；每次 accepted/deduplicated 刷新
  `imported_at` + `captured_at`。
- `AppRuntime.enqueueAutoExtraction`：任务表查重（同来源 queued/running 提取跳过）。
- 扩展：popup 新增「当前对话」状态行 + 暂停/继续按钮（本地即时生效 + 同步桌面端）；
  background 持有 `pausedConversations`（storage.local）、捕获 `ixaeon:tab-conversation`
  上报定位当前对话（popup 打开时 active tab 是 popup 自身，不能靠 tabs.query）；
  content script 提交前 background 检查暂停（本地拦截）；manifest 增加 `tabs` 权限。

### 5. MCP 开发/安装闭环（P1-3）

- `electron-builder.yml`：`extraResources: from ../mcp/dist → to mcp`（打包前
  package-windows.mjs 先跑 apps/mcp 的 vite build）。
- `mcpSnippet.ts`：命令 = Electron 可执行自身；env 带 `ELECTRON_RUN_AS_NODE=1` +
  `IXAEON_LOCAL_TOKEN`（令牌不进命令行）；开发模式从 exe 位置逐级向上实查
  `apps/mcp/dist/index.mjs`（existsSync 校验，不再盲拼路径）。
- 验证：win-unpacked 产物真实 STDIO initialize + tools/list（见 REVIEW_PACKET 第 4 节）。

### 6. 自定义数据目录（P1-8）

`appRuntime.completeSetup` 重构：自定义目录时「ensureDataDirLayout（不可写即抛，
旧指针未动）→ 新目录写完整 config（含 safeStorage 加密 Key + localToken）→ 建库 +
首个项目 → 最后 setDataDirChoice 切指针」；返回 `restartRequired`，Setup 向导展示
重启提示。默认目录路径仍在当前进程就地完成。

### 7. 导出、恢复和失败回滚（P1-7）

`archiveStore.ts` 重写：
- 导出新增 `data/{projects,sources,segments,items,item-evidence,corrections,
  work-runs,permissions}.json`（formatVersion=1 + count + rows）。
- 恢复五阶段：staging 解压（条目白名单 + zip slip 严格校验，条目名统一正斜杠）→
  staging 内校验（SQLite 头 / integrity_check / 迁移版本兼容 / raw_path 严格格式 +
  布局一致 + vault 文件存在；Windows 反斜杠 raw_path 规范化写回）→ 关连接 →
  备份 rename（**失败立即中止**，异常不吞）→ 原子替换 + 替换后校验；catch 分支
  回滚备份（备份目录保留，绝不留半个新库配半个旧 vault）。
- `previewRestore` 签发一次性 `previewToken`（10 分钟）；`restoreDataWithToken`
  消费凭证后恢复 —— 主进程不允许绕过预览。
- AppRuntime.restoreData 失败时重启本地 HTTP 服务（应用保持可用）。

### 8. 日志隐私（P1-9）

`logger.ts` 重写：正文键白名单（text/content/prompt/…/error/file 等 28 个）→
`[content N chars sha256:xxxxxxxxxxxx]` 摘要（不可复原）；敏感键（token/apikey/…）
同样摘要；Error/cause 递归；message 超 200 摘要；普通字符串上限 300；debug 同清洗。
测试从「完整串不存在」升级为「开头/中间/结尾标记 + 独特短语全部不存在」。

### 9. E2E、真实验收与审核材料（P2-11）

- 新增测试文件：`fixes.test.ts`（15 项）、`archiveFixes.test.ts`（8 项）、
  `localServer.test.ts`（9 项）、`semanticAcceptance.test.ts`（4 项）；
  desktop e2e 扩到 9 项（MCP 真实握手 / 桌面服务真实工具调用 / 票据伪造拒绝）；
  扩展 e2e 增加暂停-继续闭环 + 3 张弹窗截图。
- 截图：`screenshots.spec.ts` 采集 9 张桌面页面 + 扩展 3 张 = 12 张真实截图。
- 导出样例：语义验收测试真实生成 `ixaeon-export-sample.zip`（两份思想文档数据）。
- REVIEW_PACKET 重写：端口 43120→43191 修正；逐项区分自动化/人工/未验证；
  交付物含安装包 SHA-256 与安装版 MCP 真实调用结果。

---

## 三、过程中发现并处理的额外问题

1. **pnpm list --json 污染**：`corepack pnpm package:windows` 下 electron-builder
   的 node-module 收集器拿到带 corepack 提示的 stdout → "No JSON content found"。
   修复：打包脚本剥离 `npm_*/pnpm_*/COREPACK_*` 环境变量（node 直跑不受影响）。
2. **FTS trigram 词长**：2 字中文词（析衍）在 trigram 索引下 MATCH 不到 —— 词长
   阈值提到 3，短词走 LIKE 兜底。
3. **appendCapturedTurns 参数错位**：INSERT 列 11 个（occurred_at 在其中）但少传
   了一个值 —— 集成测试抓出后补上（occurred_at = now）。
4. **JSZip 条目名跨平台**：Windows 导出 raw_path 含反斜杠，ZIP 条目统一正斜杠，
   恢复时反向规范化。
5. **prettier 误格式化基线文档**：`开发计划.md` 被 format 改了一处空格 —— 还原并
   把两份验收基线文档加进 `.prettierignore`。

---

## 四、验证结果（全部命令实跑）

| 命令 | 结果 |
|---|---|
| `corepack pnpm verify` | 全部通过（lint / format / typecheck / unit 16 / integration 97 / build） |
| `corepack pnpm test:e2e` | desktop e2e 9 passed；extension e2e 全部断言通过 |
| `corepack pnpm package:windows` | 成功（extraResources 携带 mcp/index.mjs） |
| 安装版 MCP 握手（win-unpacked + ELECTRON_RUN_AS_NODE） | initialize ✅ tools/list 4 工具 ✅ 桌面未运行错误可操作 ✅ |
| 安装包（一轮） | 122,562,511 字节，SHA-256 `CE4631447B7165BB203D2D6035E703B9F6471AC12244A917C5EF81371616C039` |
| 安装包（二轮） | 122,566,050 字节，SHA-256 `4D9184DA61A62A1FA66524D9BC3173B2431A0160A50C45A41DDD9297D0845607` |
| 安装包（三轮，最终交付物） | 122,568,319 字节，SHA-256 `D9F8530A45A4F0EA73B3D38456B22A93822C0055B1A9BAC67D5CD88C412D91F7` |

新增/修改测试合计：单元 16（日志断言升级）、集成 97（新增 36 项回归）、
desktop e2e 9（新增 3 项）、扩展 e2e（新增暂停闭环 8 断言）。

---

## 五、未完成事项（如实声明）

1. 自定义数据目录的「向导→重启→直达主界面」完整 e2e 未自动化（环境变量注入优先
   级所限，核心逻辑已单测级验证）。
2. 真实 OpenAI 模型的六组语义问答未人工执行（需用户 API Key；自动化覆盖检索与
   引用层）。
3. 真实 chatgpt.com 的人工验收未执行（扩展 e2e 为 mock 页面全流程）。

---

# 二轮修复记录（2026-09-05，回应二次验收报告 R1–R9）

二次验收报告（`IXAEON_v0.1_二次验收报告_2026-09-05.md`）以 11 项独立业务测试
（`apps/desktop/test/review/review-20260905.test.ts`）复现了 R1–R8 九组问题，
并在打包产物上复现 R9。本轮按报告建议顺序逐项修复；修复前独立测试 11/11 失败，
修复后 **11/11 通过**，并纳入 `pnpm verify` 持续回归。

## R1 · 恢复凭证实例隔离

审核复现：`previewRestore()` 与 `restoreData()` 各自 new 一个 ArchiveService，
previewToken 存在实例内存 Map 里 —— 预览后确认恢复报「恢复凭证无效」。

修复：把凭证注册表提升为**进程级模块单例**（`archiveStore.ts` 的
`restoreTokenStore` + `issueRestoreToken()`），同进程内任意实例核销；
一次性使用、10 分钟有效期、未预览拒绝的规则全部保留。
对应更新了 archiveFixes.test.ts 的凭证用例（跨实例核销成功、二次使用失败）。

## R2 · 恢复失败的精确回滚 + 运行时重建

审核复现两个回滚窗口：备份 vault 失败时已移走的旧库不回位；安装 vault 失败时
留下「新数据库＋旧 vault」。根因是回滚只看单一的 `moved` 标志。

修复：
- `restoreData` 引入四个步骤状态位（oldDbInBackup / oldVaultInBackup /
  newDbInstalled / newVaultInstalled），catch 分支按实际完成情况回滚：
  先移开已安装的新数据（部分安装的 vault 移入 staging 保留核查），
  再把旧数据库与旧 vault **一起**还原；回滚自身失败时抛出明确错误
  并声明备份目录位置，不再声称「原数据可用」。
- `AppRuntime.restoreData` 失败分支新增 `rebuildRuntimeServices()`：
  重开数据库 → 重建 permissions/sources/projects/search/imports/items/jobs →
  `LocalServer.rebindDeps()`（新增方法，重绑数据服务）→ 重新注册任务处理器并
  启动队列 → 重启 HTTP 服务。界面与本地接口在恢复失败后继续可用。

## R3 · 撤销授权的完整覆盖

- `ItemService.getEvidence()`：返回前对每个关联来源 `assertSourceAuthorized`
  ——撤销后桌面「理解依据」与纠正预览不再暴露片段正文与摘录。
- 提取器：模型调用循环**每次请求前**重新检查授权（撤销后取消尚未发送的块，
  review 实测从 4 次模型调用降为 1 次）；事务提交前做最终检查。

## R4 · 无效引用 = 整次替换失败

模型返回的引用（含摘录校验）存在任一无效时，提取明确抛出
「模型返回 N 条无效引用/依据，本次提取已取消，现有理解保持不变」；
不再出现「跳过坏引用后仍然清空旧理解」。
「合法分析结果为空」（模型未给出结论）保持旧理解并返回 0 inserted —— 两种情况
明确区分。extraction.test.ts 按 R4 契约重写（旧断言把「错误引用跳过」视为成功）。

## R5 · 摘录真实性校验

新增 `isExcerptGroundedInSegment()`：摘录与片段文本经空白/引号规范化后必须
子串匹配，否则视为无效依据（触发 R4 整次失败）。规则明确、有限、可追溯，
用户看到的每段引文都能在原文中定位。相关测试的 FakeProvider 摘录全部改为
引用片段中的真实原文。

## R6 · 说话人角色保留

`buildBlocks` 的引用头改为 `[S1]（user）` / `[S1]（assistant）`（保留片段真实
role），长段展开（S1.2…）与重新拼块同样保留，不再硬编码 `（doc）`。

## R7 · 防抖窗口后的补分析

`maybeAutoAnalyze` 重写：窗口内（60s）到达的新内容标记 `pendingAnalysis` 并
安排**窗口结束后的补分析计时器**（每来源一个计时器，多次变更合并为一次）；
补分析前复查采集开关、autoAnalyze、域授权；重复内容（accepted=0）不清除
pending。`AppRuntime.enqueueAutoAnalyze` 不再因「已有排队/运行中任务」丢弃
再次分析的需求（提取幂等，最终状态一定是最新版本）。

## R8 · 可靠的会话绑定 + 暂停迁移

- 契约：`captureBatch.conversation.sessionId`（可选）。
- 扩展 content.ts：`currentCaptureSession()` —— 同标签页、可见轮次覆盖上一批
  （DOM 快照超集）视为同一场对话延续（page:→/c/ 转正保留 sessionId）；
  否则生成新 sessionId。跨标签页/新对话必然不同。
- 服务端 `isMergeCandidate`：双方都有 sessionId → 必须一致；任一方缺失 →
  回退「临时来源全部片段都在批次内」的完整包含检查。仅首句相同绝不合并。
- 暂停迁移：合并前若候选临时来源被暂停 → 把暂停状态迁移到正式 externalId
  并立即 403，不允许借身份转正绕过暂停。

## R9 · envOverride 由主进程返回

`AppState` 新增 `envOverride` + `dataDirSource`（AppRuntime 按 resolveDataDir
真实解析返回；主进程 IPC 兜底同步）；Setup.tsx 改用 `state.envOverride`，
不再用「目录字符串非空」推断（正常启动也有非空默认目录）。

## 二轮验证结果（全部实跑）

| 命令 | 结果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.config.ts` | **11/11 通过**（修复前 11/11 失败） |
| `corepack pnpm verify` | 全绿（unit 16 / integration **98** / review 11 已纳入 / build） |
| `corepack pnpm test:e2e` | desktop 10 passed + extension 全断言 |
| `node apps/desktop/test/review/packaged-20260905.mjs` | 3 项检查全部通过（R9 勾选框可用 / 后端自定义目录+重启保留 / 搬迁产物+无 Node PATH 的 MCP 四工具调用与写回持久化） |
| `corepack pnpm package:windows` | 成功；安装包 122,566,050 字节，SHA-256 `4D9184DA61A62A1FA66524D9BC3173B2431A0160A50C45A41DDD9297D0845607` |

## 二轮后仍未验证事项（如实）

1. 真实 OpenAI 模型的六组语义问答（需用户 API Key；不把 FakeProvider/检索命中
   当作语义验收 —— 与二次验收报告口径一致）。
2. 当前真实 chatgpt.com 页面的人工验收（扩展 e2e 是受控测试页面）。
3. NSIS 安装、卸载和全新 Windows 用户全流程（本轮实跑的是交付目录中的
   win-unpacked 副本，未安装到用户系统）。

---

# 三轮修复记录（2026-09-05，回应三次验收报告 N1–N6）

三次验收确认上轮 R1–R9 原始复现全部保持解决，但以 13 项相邻场景检查
（`apps/desktop/test/review/*round3.test.ts`）发现 N1–N6：修复前 12 项失败
（T9 正向对照通过），修复后 **13/13 通过**并纳入 `pnpm verify` 持续回归。

## N1 · 会话编号真正参与来源隔离

审核复现：扩展发了 sessionId，但桌面端建源时没存、查询时也不看 —— 不同会话
同首句仍被合并；两个同路径标签页共用一个来源。

修复：
1. 创建来源时把 sessionId 写入 `metadata_json`（T1 直接断言）；
2. 来源查找增加会话比对：同 externalId 但 sessionId 不同 → 视为不同对话
   （T2：两个同路径/同标题标签页各自成源）；
3. 合并候选判定收紧：双方都有 sessionId 时必须一致；「完整包含兜底」只用于
   双方都没有 sessionId 的旧客户端，且要求临时来源**全部**片段都在批次内。

## N2 · 暂停绑定到稳定会话，恢复闭环

审核复现：暂停临时对话 → 转正被 403 → 用户在正式对话上点「继续」→ 下一批
又被 403（临时 ID 的暂停没被清除）。

修复：暂停状态双落点 —— `pausedConversations`（externalId，兼容）+
`pausedSessions`（sessionId，稳定身份），并用 `sessionAliases`
（externalId→sessionId，在任何拒绝路径之前记录）把它们关联。恢复操作解析
该对话的会话，清除**全部有效别名**的暂停。链路「暂停临时 → 转正 403 →
明确继续 → 200 采集」闭环（T4）。

## N3 · 补分析计时器跟随暂停/恢复/停止

- 计时器携带对话身份（externalId + sessionId），触发前复查该会话暂停状态
  （T5：暂停后不再触发待补分析）；
- `pause-conversation` 时同步取消该会话的计时器与 pending；
- `AppRuntime.restoreData` 在关闭数据库**之前**调用
  `localServer.stopBackgroundTasks()`（T6：恢复成功后推进 61 秒，无旧回调
  访问已关闭连接）；应用退出（stop）同样清理。

## N4 · 凭证拒绝后不再叠加第二套运行时

审核复现：无效凭证被拒时旧连接/旧队列还在，失败分支却无条件 rebuild ——
打开第二个连接、建第二个队列；随后合法恢复真实报 EBUSY（文件被旧连接占用）。

修复：失败处理按实际进度分类。关库之前的失败（凭证无效/过期/包损坏）→
原运行时未被触动，直接复用并重启本地服务，不重建。T7（仍是一套运行时与队列）、
T7b（随后合法恢复成功，无需重启解锁）通过。

## N5 · 回滚未完成 = 明确的恢复故障态

审核复现：安装 vault 与回滚 vault 双双重命名失败时，归档层正确报「回滚未完成」，
但 AppRuntime 仍无条件 rebuild —— openDatabase 静默创建了空库并启动服务。

修复：归档层在回滚自身失败时抛出携带 `rollbackIncomplete` 标记的错误；
AppRuntime 据此进入恢复故障态 —— 不重建、不启动服务、不写数据，日志如实
记录「旧数据完整保留在备份目录」。`rebuildRuntimeServices` 另加
`existsSync(dbPath)` 兜底，拒绝创建空库。T8（不建空库、不 startServer）通过；
T9 正向对照（单次安装失败 → 回滚 → 运行时可用 → MCP 200）保持通过。

## N6 · 长段子块编号头预算

审核复现：30,000 字符无换行 user 片段切分后，最大完整块 8001 字符 ——
预算只按 `[S1]` 头计算，第二块实际用 `[S1.2]` 头。

修复：预算按基础头 + 后缀位数余量（12 字符）计算，切分后用真实头逐一校验，
超限收紧预算（×0.85）重切；任何完整包装块都不超过 8000（T10）。

## T11/T12 · 客户端会话身份按生命周期

弃用「正文超集」判据（两个不同对话同文本会误绑；重新生成会误断），改为：
同 URL 同会话；formal→不同 formal 永远新会话；仅 page:→/c/ 且首条用户消息
一致视为转正延续。T11/T12 通过。

## 三轮验证结果（全部实跑）

| 命令 | 结果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.round3.config.ts` | **13/13 通过**（修复前 12/13 失败） |
| `corepack pnpm verify` | 全绿（unit 16 / integration 98 / review 11 / **review-round3 13** / build） |
| `corepack pnpm test:e2e` | desktop 10 passed + extension 全断言 |
| `node apps/desktop/test/review/packaged-20260905.mjs` | 3 项检查全部通过 |
| `corepack pnpm package:windows` | 成功；安装包 122,568,319 字节，SHA-256 `D9F8530A45A4F0EA73B3D38456B22A93822C0055B1A9BAC67D5CD88C412D91F7` |

## 三轮后仍未验证事项（如实）

1. 真实 OpenAI 模型的六组语义问答（需用户 API Key）。
2. 当前真实 chatgpt.com 页面的人工验收（扩展 e2e 为受控测试页面）。
3. NSIS 安装、卸载和全新 Windows 用户全流程（实测为 win-unpacked 测试副本）。
