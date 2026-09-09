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
| 安装包（三轮） | 122,568,319 字节，SHA-256 `D9F8530A45A4F0EA73B3D38456B22A93822C0055B1A9BAC67D5CD88C412D91F7` |
| 安装包（四轮） | 122,569,581 字节，SHA-256 `5913D7F372078D8FFB46E5334CF2DFF3EBDDD114843294E371EA0492778933A7` |
| 安装包（M0 收尾） | 122,573,413 字节，SHA-256 `616CEE4B3BAC5D0C5DBD03F204761C512025EA9AEF33C49C0C76745E40409051` |
| 安装包（M1.2） | 122,576,020 字节，SHA-256 `220B1D35129E7AC5320D86F09171EC037AC838D06848B5A53B8DA9AA80A158D4` |
| 安装包（M2） | 122,578,473 字节，SHA-256 `D19271CAFD825BB504BC386C7039371D2EA0823D8EA53D7839938D7F526BAEFE` |
| 安装包（M3） | 122,580,929 字节，SHA-256 `899B937C623C001D8F1F888E6FD60BB8D9A0BD1C87C1CBCDCC1C549625E8AFFC` |
| 安装包（G1–G8 修复） | 122,586,726 字节，SHA-256 `3896CBA8D3B97FABFC0A932B94C0A05B056E8AF58E4AD7932682C0DB390A5C9F` |
| 安装包（M2 语义验收补齐） | 122,586,721 字节，SHA-256 `B060075828A3453B1D7040ECB7FDD00F11088D49E795B160574A9875957F9819` |
| 安装包（复核反馈修复，最终交付物） | 122,587,174 字节，SHA-256 `F8307ACFC511A8DBA9069B5CEBA75F3781CF4F68DFA764B6C9E2F0A9FC57C196` |

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

---

# 四轮修复记录（2026-09-05，回应四次验收报告 F1–F4，v0.1.1 稳定性收口）

四次验收确认前两轮 24 项独立回归全部通过，但以 7 项连续性检查发现 F1–F4
（修复前 6 项失败，U7 对照通过）。修复后 **7/7 通过**并纳入 verify；
**放行条件 2（真浏览器→真实服务串联验收）已完成**。

## 身份与任务状态设计记录

新增 `docs/identity-lifecycle.md`（下一阶段计划 M0 第一步要求）：区分对话身份
（正式=URL / 草稿=sessionId）、采集实例（可变的页面会话）与内容版本，并列出
刷新、多标签、A→B→A、转正、暂停转正、开关变化等场景的 ID 变化规则表。

## F1 · 身份模型重定义

审核复现：同一正式 URL 刷新后 sessionId 变化 → 服务端当成新对话（U1 甚至撞
唯一约束 400；U2 拆成两个来源）；同路径草稿 A→B→A 产生三个来源（U3）。

修复（`handleCaptureBatch` 重写查找逻辑）：
- 正式对话：身份 = URL。查找该 URL 的来源，任意 sessionId 都归属同一来源；
- 草稿：身份 = sessionId。按「同路径 + metadata.sessionId 精确匹配」找回
  自己的来源；找不到保守新建并持久化 sessionId（旧客户端无标识时仅在
  「同路径唯一且同样无标识」时延续）；
- 建源+片段登记、建正式源+合并在**同一事务**（失败完整回滚，不留半成品）。

## F2 · 分析合并按稳定来源身份

`lastAutoEnqueue` / `pendingAnalysis` / `trailingTimers` 全部改按 **sourceId**。
同路径的草稿 A/B/C 各有独立待分析状态与计时器（U4：三个来源全部收到补分析）；
同一来源多次更新仍合并为一次；计时器条目携带 externalId/sessionId 供暂停复查。

## F3 · 恢复拒绝不丢待分析工作

`stopBackgroundTasks()` 从凭证校验之前移入 `closeCurrentDb` 回调 —— 无效凭证、
包损坏等早期失败发生在关库之前，原运行时（含待补分析计时器）完整保留
（U5：拒绝后窗口结束，第二次分析照常发生）。成功/回滚/故障三条路径的
N3–N5 语义保持（T6/T7/T7b/T8/T9 仍绿）。

## F4 · 自动任务执行时复查开关

- `registerJobHandlers`：auto 任务执行前复查 autoAnalyze、capture.enabled、
  来源授权、所属会话暂停（`isSourceConversationPaused`，按 metadata.sessionId
  与别名解析）；不满足 → 以 `cancelled` 状态落库（不调模型、可见、可重试）。
  手动任务不受自动分析开关约束（关闭自动分析不封死手动操作）。
- 提取器接受 `shouldContinue` 注入：每个模型块前与结果提交前复查
  （U6：关闭开关后 0 次模型调用；U7 对照正常成功）。
- 新增错误码 IXA0023 JOB_CANCELLED；JobQueue 识别 jobCancelled 标记落
  cancelled 状态。

## 串联验收（放行条件 2）

新增 `apps/extension/e2e/serial-real.cjs`（接入 `pnpm test:e2e` 第三阶段）：
真实 Chromium 加载构建产物扩展 → 真实桌面应用（临时数据目录，真实配对码，
公开 IPC 完成设置并开启采集）→ 扩展把 mock chatgpt.com 页面采集进**真实**
本地服务与 SQLite。断言直接读真实数据库：

1. 真实配对码配对成功；2. 正式对话采集入库（2 片段）；3. 真实浏览器 reload
（sessionId 必然变化）不重复建档且 sourceId 不变；4. 追加内容增量入库；
5. 暂停当前对话后新内容不入库、继续后恢复；6. SPA pushState 草稿转正合并
（临时来源消失、来源总数正确）。模型 0 调用（autoAnalyze 关闭）。

## 四轮验证结果（全部实跑）

| 命令 | 结果 |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.round4.config.ts` | **7/7 通过**（修复前 6/7 失败） |
| `corepack pnpm verify` | 全绿（unit 16 / integration 98 / review 11 / round3 13 / **round4 7** / build） |
| `corepack pnpm test:e2e` | desktop 10 + extension 全断言 + **serial 串联验收 PASS** |
| `node apps/desktop/test/review/packaged-20260905.mjs` | 3 项检查全部通过（新产物） |
| `corepack pnpm package:windows` | 成功；安装包 122,569,581 字节，SHA-256 `5913D7F372078D8FFB46E5334CF2DFF3EBDDD114843294E371EA0492778933A7` |

## 四轮后仍未验证事项（如实）

1. 真实 OpenAI 模型六组语义问答（需用户 API Key）。
2. 当前真实 chatgpt.com 页面人工验收（串联验收用的是本地 mock 页面 +
   真实服务/数据库；真实站点结构兼容性仍需人工）。
3. NSIS 安装、卸载和全新 Windows 用户全流程（实测为 win-unpacked 副本）。
4. 下一阶段计划 v0.1.1 M0.2 的持久化版本三元组
   （contentRevision/analyzedRevision/targetRevision）未实现 —— 当前
   「待分析」状态仍部分依赖内存计时器（已在 docs/identity-lifecycle.md
   第 4 节列为演进项）；崩溃重启后的待分析恢复属该项范围。

---

# M0 稳定性收尾记录（2026-09-05，实施《下一阶段开发计划》M0）

按 [docs/identity-lifecycle.md](docs/identity-lifecycle.md) 的设计，实施持久化版本
三元组与任务生命周期收尾，关闭「待分析状态依赖内存计时器」的可靠性缺口。

## 1. 版本三元组（迁移 2）

迁移 2（`source-revisions-and-job-scheduling`）：
- `sources.content_revision` / `sources.analyzed_revision`：可用内容版本与已分析
  版本。语义：导入=1；追加影响理解的内容（新片段/编辑/分支切换）递增；完全
  重复提交不递增；提取失败/取消/引用不合法不得推进 analyzed。
- 旧行回填 1/1：历史来源标记为已按旧规则分析，避免升级后批量触发补分析
  （需重分析可手动）。迁移在旧库副本（仅迁移 1 + 数据）上验证。
- `jobs.not_before`：退避重试的持久调度列；`session_aliases` 表：externalId →
  sessionId 别名（从 config.json 迁出，上限 500 条裁剪）。

## 2. 分析任务生命周期

- **入队合并**：同来源 queued/running 唯一（排除当前任务），窗口内多次更新合并。
- **目标版本锁定**：任务开始时取 content_revision 为目标；执行期间新内容不影响
  本次结果；完成后 `advanceAnalyzedRevision` 守卫推进（WHERE analyzed < target，
  旧任务不能覆盖新结果）；content > analyzed → 补队一次（排除自身）。
- **启动扫描**：`sweepPendingAnalysis()` 在启动/开关重开/对话恢复时找回欠分析
  来源（网页来源复查开关/授权/暂停；导入来源沿用导入管线语义；上限 50）。
- **执行时复查**：自动任务执行前复查 autoAnalyze/采集开关/授权/暂停（F4）；
  每块与提交前经 `shouldContinue` 复查；取消以 cancelled 落库（IXA0023）。
- **有限退避重试**：暂时性失败（MODEL_CALL_FAILED/SERVER_UNAVAILABLE/retriable
  ModelError）自动重试 3 次（not_before 持久调度，5s/30s/120s）；认证/预算/权限/
  校验/取消不重试。

## 3. 退出等待

`stop()`：停止接收 → `jobs.idle()` 等待在途任务结束 → 关库。消除关库瞬间
在途提取写库的竞态。

## 4. 每采集写 config.json 问题

sessionAliases 迁入 SQLite 后，采集路由不再每批重写整份配置文件；
pausedConversations/pausedSessions 仍留在 config（用户操作才变更，量小）。

## 5. 验证结果（全部实跑）

| 命令 | 结果 |
| --- | --- |
| `corepack pnpm verify` | 全绿：unit 16 / integration **110**（含 m0-core 4 + m0-gates 4）/ review 11 / round3 13 / round4 7 / build |
| `corepack pnpm test:e2e` | desktop 10 + extension 全断言 + serial 串联 PASS |
| `node apps/desktop/test/review/packaged-20260905.mjs` | 3 项检查全部通过（M0 收尾后新产物） |
| `corepack pnpm package:windows` | 成功；安装包 122,573,413 字节，SHA-256 `616CEE4B3BAC5D0C5DBD03F204761C512025EA9AEF33C49C0C76745E40409051` |

M0 门槛对照：本轮 4 项门槛测试（运行中到达新版本/窗口内退出重启/取消后模型
返回/恢复失败保留待处理）全部通过；U1–U7 与前两轮 24 项独立回归全部保持。

## 6. 未完成事项（如实）

1. 真实 OpenAI 模型六组语义问答（需用户 API Key）。
2. 当前真实 chatgpt.com 页面人工验收。
3. NSIS 安装、卸载和全新 Windows 用户全流程。
4. v0.2 M1–M3（归属继承/状态展示/确认动作/编码闭环）按计划待 M0 通过审核后分批实施。

---

# M1.2 实施记录（2026-09-05，展示真实状态）

按《下一阶段开发计划》M1.2 实施「来源真实状态」：

## 1. 数据层
- 迁移 4：`sources.analyzed_at`（最后成功分析时间；仅在 analyzed_revision 前进时
  由 `advanceAnalyzedRevision` 更新，与 imported_at 分离）。
- `SourceStore.list`：联查项目名（LEFT JOIN projects）与最近 extract 任务
  （status/error/created_at，按 payload LIKE sourceId 取最新）；
  `SourceWithStats` 新增 `projectName` + `analysis` 对象；
  契约 `SourceListItem` 同步扩展。

## 2. UI（Sources 页）
- 表格新增「所属项目」「状态」列；「最近收到内容」替换原「导入时间」列。
- `analysisStatus()` 文案映射（普通人可读）：
  已收到，等待分析 / 正在分析… / 已分析最新内容 / 有新内容尚未分析，当前显示
  旧理解 / 自动分析已关闭，开启后处理 / 授权已撤销 / 分析失败，可以重试
  （附错误摘要 + 行内重试按钮，调用 reextractSource 手动任务）。
- 5 秒低频轮询（页面可见时才刷新，静默更新不清空列表）；状态刷新不调用模型。

## 3. 验证（全部实跑）
- m1-status 4 项（等待分析/追平+analyzed_at/欠分析可见/失败原因可见）纳入 verify；
- verify 全绿（integration 111），desktop e2e 10、extension 全断言、serial 串联 PASS；
- 打包复核 3 项；安装包 122,576,020 字节，SHA-256
  `220B1D35129E7AC5320D86F09171EC037AC838D06848B5A53B8DA9AA80A158D4`。

## 4. 未完成
M1 验收的界面级人工确认、M2/M3 批次按计划待续；真人验收 A–D 待用户执行。

---

# M2 实施记录（2026-09-06，确认与改口保护）

按《下一阶段开发计划》M2 实施「重要理解可确认，改口不会被冲掉」。

## 1. 数据模型（迁移 5）
`items.confirmation（none/confirmed/rejected，CHECK 约束）+ confirmation_at`。
三维度正交：`origin`（谁提取的）/ `confirmation`（用户是否确认）/ `state`（是否有效）。

## 2. 动作与服务
- `ItemService.confirm/reject`：superseded 拒绝操作；清待讨论；留时间戳；
  确认不篡改 origin（AI 条目确认后仍标记 origin=ai + confirmation=confirmed）。
- IPC `confirmItem/rejectItem` + 审计（item.confirmed/item.rejected）。
- Inbox：确认正确 / 不采纳 / 暂不处理；Understanding：用户已确认/已不采纳徽章
  + AI 条目的确认/不采纳按钮。

## 3. 阅读路径排除 rejected
- prepare_task 简报（新增「用户已确认」后缀标注）；问答上下文
  （rejected 排除 + confirmed 排序提前）；search_context 条目检索。
- rejected 条目保留可追溯（不删除、不 superseded），仅退出「当前理解」消费面。

## 4. 人工改口优先（重新提取保护）
- deleteOldAiItems 仅删 confirmation='none' 的 current AI 条目；
- 已确认/已不采纳条目保留；新结论与它们高度相似（bigram Jaccard ≥0.6）
  → 跳过并计 skippedPreserved —— 不复活已否决建议、不重复已确认结论。

## 5. 冲突真的可见
Understanding 页查询改为不带 state 过滤（current + disputed 一起取回），
分组展示「存在冲突的结论」卡片——修复「只取 current 再从中筛 disputed」
导致 disputed 永远不可见的问题。

## 6. 验证（全部实跑）
- m2-confirmation 5 项纳入 verify；verify 全绿（integration 116）；
- desktop e2e 10、extension 全断言、serial 串联 PASS；
- 打包复核 3 项；安装包 122,578,473 字节，SHA-256
  `D19271CAFD825BB504BC386C7039371D2EA0823D8EA53D7839938D7F526BAEFE`。

## 7. 未完成
计划 M2 的「六组固定语义资料验收」（AI 提议用户未答应等六类情形的界面+
MCP 输出端到端验证）与 M3 批次待续；真人验收 A–D 待用户执行。

---

# M3 实施记录（2026-09-06，编码 AI 的开工与收工闭环）

## 1. 开工背景（prepare_task）
- `BriefingEntry.origin`：ai / user / work_result —— 简报每条结论标注来源；
  recent_work 固定 work_result；confirmed 条目文本带「（用户已确认）」。
- `PrepareTaskOutput.coverage`：`maxContentRevision / maxAnalyzedRevision /
  hasUnanalyzedContent`（按来源版本三元组聚合）；落后时 staleness_notice
  明确「有新内容尚未分析，本简报可能落后于最新对话」——不伪装最新。
- MCP 初始化说明新增 3 条规则（7 origin 含义 / 8 coverage 复核 / 9 未运行
  测试如实写、agent 自报不等于用户验收）。

## 2. 收工回写（record_work_result 幂等）
- 迁移 6：`work_runs.client_ref`（部分唯一索引，NULL 不受限）。
- 可选 `client_ref`：相同键相同内容重试 → 返回已有 work_run_id +
  `deduplicated: true`，不重复入库；相同键不同内容 → CONFLICT 明确报错；
  旧客户端不传 → 原行为（UUID）完全兼容。
- MCP 工具入参暴露 client_ref（重试场景说明写入工具描述）。

## 3. 验证（全部实跑）
- m3-loop 6 项纳入 verify（来源区分/覆盖×2/幂等×3）；
- verify 全绿（integration 126）；desktop e2e 10、extension 全断言、
  serial 串联 PASS；打包复核 3 项（含独立进程四工具真实调用与写回持久化）；
- 安装包 122,580,929 字节，SHA-256 `899B937C623C001D8F1F888E6FD60BB8D9A0BD1C87C1CBCDCC1C549625E8AFFC`。

## 4. 未完成（如实）
- 计划 M3 验收第 2 项「真实编码 AI 客户端完成一项授权小任务并回写」需用户
  可用客户端与授权，未执行；M2 六组语义资料验收同前记录。
- 发版门槛四项（真实网页/真实模型/安装器/短期日用观察）待用户执行。

---

# v0.2 验收修复记录（2026-09-06，回应 G1–G8）

15 项独立检查修复前 14 失败，修复后 **15/15 通过**并纳入 verify
（verify 新增 review-v02 步骤）。按报告建议顺序实施：

## G1 取消信号（V01）
真实队列取消信号（ctx.signal）与自动开关/暂停检查组合注入提取器 shouldContinue
——手动任务同样受取消约束；提交后已中止 → 抛 JOB_CANCELLED（不推进 analyzed、
不入库）。已发出的网络请求无法收回，但不发后续块、不提交被取消结果。

## G2 崩溃恢复（V02）
sweepPendingAnalysis 启动阶段：数据库中无执行者的 running 任务（上一运行代次
崩溃遗留）转 queued 重新排队（重试预算保留、审计记录），恢复受开关/权限/暂停复查。

## G3 版本事实（V03/V04/V05）
- 切回旧分支（旧指纹重新激活）= 当前有效内容变化 → 递增 content_revision；
- coverage 按每个来源检查版本差再聚合（不比较各来源各自的 MAX）；
- 迁移 7 修正迁移 2 的伪造回填：无 items 且无 succeeded 任务的来源
  analyzed_revision 回退 0；迁移绝不调用模型，补分析由启动扫描按开关控制。

## G4 人工改口保护（V06/V07）
保护集 = superseded（被纠正前驱）+ confirmed/rejected + origin=user 全链。
字符相似度只作候选信号：**完全相同才跳过**；相似但不相同（含只差一个
「不」的相反意见）→ 入库并 needs_review=1，与人工决定形成可见冲突由用户裁决。

## G5 归属保护（V08/V09）
迁移 8 `items.manual_project`：人工 assignToProject 置 1；来源级批量重绑
（bindProject）只搬 manual_project=0 的自动继承条目。提取器提交前重验来源
归属——以提交时点归属入库，不把新理解写回旧项目。

## G6 重要决定待确认（V10）
decision/rejected_option/project_summary 且未确认 → needs_review=1（与
项目归属正交）；简报该类条目标「（待用户确认）」并同步进 risks 组——
编码 AI 必须能看到待确认状态，不混成用户已拍板。

## G7 回写幂等（V11/V12/V13）
client_ref 与内部 ID 分开保存（work_run_id 恒 UUID，引用长度契约不破坏）；
幂等比较含解析后项目 ID + commit_ref + 全部有意义字段——跨项目或不同
commit 的同键提交 → CONFLICT；完全相同 → deduplicated:true。

## G8 完整输出预算（V14）
预算按完整序列化输出核算（含任务/项目/coverage/时间/提示/JSON 容器）：
条目粗裁 → 完整复核 → 仍超限按优先级（work→status→rejected→loops→decisions）
逐条移除再复核；待确认/过期提示不被优先裁掉。

## 旧断言更新（按报告「可修改测试适配，不能弱化要求」）
- m0-core 迁移回填：1/1 → 1/0（G3c 新契约）
- m1-binding / extraction 归属断言：decision 已归属也 needs_review（G6 新契约）
- m2-confirmation 相似结论：跳过 → 入库待讨论（G4 新契约）

## 验证（全部实跑）
- review-v02 15/15；verify 全绿（unit 16 / integration 126 / review 11+13+7+**15** / build）
- desktop e2e 10、extension 全断言、serial 串联 PASS；打包复核 3 项
- 安装包 122,586,726 字节，SHA-256 `3896CBA8D3B97FABFC0A932B94C0A05B056E8AF58E4AD7932682C0DB390A5C9F`

## 仍未验证（如实）
M2 六类语义资料界面+MCP 串联验收（可先合成资料自动化，未交付）；真实网页/
真实模型/真实编码 AI 客户端/安装器/短期日用观察——需用户参与，见 REVIEW_PACKET 第 11 节。

---

# M2 六类语义资料串联验收补齐（2026-09-06）

补 v0.2 验收报告第四节材料缺口第 1 项（此前误判为「需与真人验收一并执行」——
报告明确指出可先用合成资料与 FakeProvider 自动化）。

## 交付
1. **固定资料集** `M2_SCENARIOS`（test-fixtures）：六类场景各自含原文、模型
   提取输出、用户动作、先行的预期判据（持久化 + 简报）。判据先行——与真实
   模型验收共用，避免事后照输出改答案。
2. **串联测试** `m2-semantics.test.ts`（7 项）：导入 → 提取 → 用户动作 →
   （次轮/第二来源）→ 断言 items 持久化状态 + prepare_task 简报。
   界面与持久化/MCP 消费同一 IPC 数据源（listItems 含 confirmation/
   needs_review），页面渲染由 desktop e2e 覆盖。

## 六类断言要点
- S1 AI 提议未答应：简报带「待用户确认」，不混成已拍板；
- S2 明确否决：简报排除、持久化保留可追溯；
- S3 后来改口：旧决定 superseded 不复活、新结论 current 带用户确认标注；
- S4 不同来源矛盾：相反结论入库待讨论、简报可见；
- S5 证据不足：open_loop 正常流转，不强制确认；
- S6 agent 声称完成：origin=work_result，与用户验收明确分离。

## 验证
m2-semantics 7/7 纳入 verify；verify 全绿（integration 133）；desktop e2e 10、
extension 全断言、serial 串联 PASS；打包复核 3 项；安装包 122,586,721 字节，
SHA-256 `B060075828A3453B1D7040ECB7FDD00F11088D49E795B160574A9875957F9819`。

---

# 用户复核反馈修复（2026-09-06）

用户对 G1–G8 修复与 M2 语义验收的复核指出三处，前两处为代码缺陷已修复：

## 1. 切回旧回答不会自动重新分析
G3a 修复让分支切换递增了 content_revision，但 maybeAutoAnalyze 仍以
`acceptedCount === 0` 直接 return——「知道内容变了，却未必开始处理」属实。
修复：appendCapturedTurns 返回 branchSwitched；采集路径改判「内容是否变化」
（新增片段或分支切换），分支切换在防抖窗口内同样安排 trailing 补分析。

## 2. 人工分配项目的条目被重提删除
G5 的 manual_project 只保护了 bindProject 批量改绑路径；deleteOldAiItems
未排除 manual_project=1。修复：删除条件加 `AND manual_project = 0`——
人工单独分配与确认/不采纳同属人工决定保护。

## 3. 六类场景测试的边界（如实回应，未修复为自动化）
测试验证「数据持久化 + MCP 简报」两端；界面消费同一 IPC 数据源，
页面渲染由 desktop e2e 覆盖。**逐类实际操作界面**未做（可后续 Playwright
界面级场景补充）；**真实模型理解能力**未验证（属发版门槛真人验收，
判据已备好）。两项均如实列入未验证项。

## 验证
review-followup 2 项纳入 verify；verify 全绿；desktop e2e 10、
extension 全断言、serial 串联 PASS；打包复核 3 项；
安装包 122,587,174 字节，SHA-256 `F8307ACFC511A8DBA9069B5CEBA75F3781CF4F68DFA764B6C9E2F0A9FC57C196`。

## 界面级六类场景补齐（反馈 3 的 UI 部分，同日追加）

新增 `apps/desktop/e2e/m2-ui.spec.ts`（Playwright 界面级，4 项，desktop e2e
共 14 项）：真实 Electron 窗口内导入六类资料后逐页操作与断言——

- S1/资料保存：未分析来源在来源页如实显示「分析失败，可以重试」等状态
  （未分析不伪装已分析——G6 语义的界面侧验证）；
- S3/理解页：无提取结果时明确空态（不显示假数据）；有条目时纠正按钮可用；
- Inbox：无待讨论条目时明确空态；确认/不采纳按钮存在且语义明确；
- S6：经生产 MCP 端点回写 agent 工作后，项目页最近工作可见，
  理解页不混入（work_result 不等于当前理解——M3 语义的界面侧验证）。

真实模型理解能力仍属发版门槛真人验收（判据备好于 M2_SCENARIOS）。

# v0.2 复审修复（2026-09-07，对复审报告 RF01–RF09）

复审报告新增核心检查 B01–B07（8 项，7 失败）与界面 BUI01（失败）。
失败证据存档（二次复审 F03 更正）：核心失败 JSON
`apps/desktop/test/review/results-recheck-20260907.json` 保留完整；**界面
BUI01 的 error-context.md 已丢失** —— Playwright 在后续复跑通过时清理了
outputDir，上一轮把它当作了永久档案，实际不是。原始界面失败细节以
复审报告（IXAEON_v0.2_复审报告_2026-09-07.md 第 5 节引用的路径）与核心
失败 JSON 为准，此处如实记录缺失，不重造记录。本轮起各轮使用独立输出
目录，失败证据先归档再复跑。
本轮全部修复并另存新结果（results-recheck-20260907-fixed.json）；未删除
任何旧断言，未写死答案。

## 修复内容

1. **RF01 保护集括号**（extractor.ts loadManualProtectionScope）：原 SQL
   相当于「属于来源 OR（纠正关系 AND 人工条件）」，普通未确认 AI 条目被
   误当保护集，重提后旧结论被删除。改为「（属于来源 ∪ 递归纠正链）AND
   人工条件」（B01）。
2. **RF02 纠正链递归**：保护范围沿 corrections 双向递归扩展（CTE UNION
   去重防循环），两次连续纠正后最新人工约束进入保护集（B02）。
3. **RF03 集中重算 needs_review**：新增 ItemService.recomputeNeedsReview
   （待处理 = 无归属 OR 重要 AI 决定未确认 OR 冲突），assignToProject 与
   bindProject 两入口共用同一事实规则（B03 两入口）。
4. **RF04 简报预算最终防线**（mcpStore.ts）：条目试放探针改按最坏情形
   （truncated=true + chars_used 99999 位数）核算；返回前对真实完整序列化
   复核，超限按装填逆序收缩（recentWork→status→risks→rejected→open_loops
   →decisions→purpose）；极端小预算抛 IXA0020 BUDGET_EXCEEDED 契约错误
   （B04，1300–1510 字符循环不再超限）。
5. **RF05 人工/纠正条目引用展开**（mcpStore.ts getSourceExcerpt）：新增
   origin=user 分支——纠正条目返回「用户纠正记录（附纠正前结论）」、手工
   条目返回「用户手工记录」，明确标注非对话原文摘录；旧结论带依据时校验
   来源授权（B05/B06）。
6. **RF06 项目页工作详情**（Projects.tsx）：摘要行直接点名失败测试与
   未完成事项；可展开详情（变更/测试全量/未完成事项，标注待用户确认）；
   加载失败如实报错（不再吞成「暂无记录」）。BUI01 附加重进页面、详情
   展开收起、项目隔离检查；新增 BUI02 验证重启后仍可见（持久化非内存态）。
7. **RF07 六类界面名实对齐**（m2-ui.spec.ts 重写场景框架）：S1 改真实
   「不采纳」流程（动作前后简报变化）；S2 改真实「确认」流程（AI 记录
   否决 + 用户确认该理解，标签「待用户确认」→「用户已确认」）；S4 构造
   两个真实来源的相反结论（方案甲/乙），断言双方保留、disputed、待处理、
   简报「存在冲突」标注、不自动选边；全部场景增加 dbExpect 持久化断言。
8. **RF08 旧 plain: 密钥迁移**（appRuntime/ipc/contracts/Settings）：
   启动时 migrateLegacyPlainApiKey——safeStorage 可用→原地升级系统加密；
   不可用→清除旧值 + apiKeyPresent=false + 设置页提示重新输入
   （settingsView 新增 apiKeyNeedsReentry）。decryptApiKey 运行期不再解码
   plain:（迁移专用入口 decodeLegacyPlainApiKey 独立导出）；保存失败文案
   不再承诺「仅本次会话的密钥」（B08/B09/B10，密钥均为合成字符串）。
9. **RF09 交付同步**：verify.mjs 新增 review-recheck（11 项）与
   review-recheck-ui（UI01/BUI01/BUI02，真实 Electron）两个步骤；
   REVIEW_PACKET 0.16 更正「UI01 已纳入 verify」的不实表述并新增 0.17 节；
   privacy-model.md 改「数据离开电脑的渠道」为如实两条（模型 API + MCP
   外部客户端可能转发给其云模型）、补扩展 tabs 权限用途（唤醒后定位
   chatgpt.com 标签页，不读其他页面）；本日志即本轮记录。

## 验证

- recheck-20260907：11/11（B01–B10，B03 两入口）通过；新结果另存
  `results-recheck-20260907-fixed.json`（原始失败 JSON 保留未动）。
- recheck UI：UI01 + BUI01 + BUI02 3/3 通过（真实 Electron，含重进页面、
  详情展开、项目隔离、重启持久化）。
- m2-ui：6/6 通过（S1–S5 场景 + S6，RF07 重写后名实对应）。
- 完整 verify 13 步全绿（lint / format / typecheck / unit / integration /
  build + 六轮 review 含本轮 review-recheck 与 review-recheck-ui）。
- desktop e2e 16/16、extension e2e 全断言、serial 串联（真扩展→真实服务→
  真实数据库）PASS。
- 打包：IXAEON-Setup-0.2.0.exe 重新生成（RF 修复进入产物），
  122,595,082 字节，SHA-256
  `3169B563A5F8CF2C61823B40A23563E443A9F6AF29643F7820EBCEB434A96E97`；
  重打包后 win-unpacked 复核 3 项通过（自定义目录 / 重启保留 / 搬迁后
  无全局 Node 的 MCP 握手 + 四工具 + 持久化回写）。未执行安装器真实
  安装流程（如实，属未验证项）。

## 已知剩余（如实）

非空旧库的真实升级路径、安装器真实安装流程、真人真实环境验证仍未执行
（与此前未完成清单一致）。会话级密钥方案明确不实现（RF08 决定：改文案
而非承诺未实现功能）。

# 二次复审修复（2026-09-08，对二次复审报告 F01–F03，提交 65927c6）

二次复审新增 8 项独立检查：4 过 4 败（R2-01/R2-02 各两入口）。
原始失败证据保留：`results-recheck-round2-20260907.json`（首次）与
`-repeat.json`（复跑）；新结果另存 `-fixed.json`（10/10，含 F01 附验 2 项）。

## F01（P1）：待处理原因集合化 —— 归属操作只解决「缺项目」

上轮 RF03 的「按事实重算」仍是整体覆写：用户显式置位（setPendingReview）
与人工约束冲突（conflictsWithProtected 编码为 needs_review=1 而非 disputed）
都会被选项目/绑来源清掉；且 bindProject 内是另一套复制规则，affected 查询
还波及 manual_project=1 条目。

修复（packages/core/src/storage/needsReview.ts 新模块 + migration 9）：

1. items 新增 `needs_reasons`（逗号分隔原因：no_project / unconfirmed /
   conflict / manual），needs_review 是它的物化视图（非空=1）。任何入口
   不再直接写 needs_review。
2. 每个操作只动自己负责的原因：归属（assignToProject 与 bindProject 经
   同一 `syncDerivedNeedsReasons`）只解除/重建 no_project；conflict（提取
   器人工约束冲突 + markDisputed 双方）与 manual 只有用户动作（确认/
   不采纳/纠正/明确解除）能清；确认/不采纳清空全部原因。
3. bindProject 只对本次真正移动的条目重算（manual_project=1 不被顺带
   改写）；来源解绑时 no_project 对被移动条目重新成立。
4. 旧库迁移：needs_review=1 → 回填当前成立的派生原因 + manual（保守，
   宁多留不静默清）；needs_review=0 → 原因留空。非空旧库升级路径仍是
   未验证项，迁移规则本身有回归覆盖。
5. recordWorkResult 的 open_loop 候选带 unconfirmed 原因（agent 自报
   永远待用户确认）。

## F02：privacy-model.md 文案更正

删除「两种渠道调用前界面均展示所用来源范围」中关于 MCP 的不实部分：
MCP 调用由已配置客户端发起，受本地令牌/来源授权/工具参数约束，IXAEON
不会逐次弹确认或展示范围。模型 API 的调用前范围展示保留（真实存在）。

## F03：证据记录更正

上轮声称「原始失败错误上下文保留未动」不准确：Playwright 复跑通过时
清理了 outputDir，BUI01 的 error-context.md 已丢失。核心失败 JSON 完整。
已如实在 dev-log 复审节与 REVIEW_PACKET 0.17/0.18 更正；本轮起各轮使用
独立输出目录、失败证据先归档再复跑。

## 验证

- recheck-round2：11/11（原 8 项 + F01-a 明确解除只清 manual + F01-b
  人工搬走后来源重绑不动其待处理 + F01-c 旧库迁移 8→9 保守回填）。
- 回归：recheck-20260907 11/11、project-audit 15/15、核心集成 135/135
  （含 B02/B03、A02/A03、确认/不采纳、连续纠正、Inbox 契约）。
- recheck-round2 已纳入 verify（review-recheck-round2 步骤）。
- 完整 verify 14 步全绿；desktop e2e 16/16、扩展 e2e、serial 串联 PASS。
- 重新打包：122,597,406 字节，SHA-256
  `43BFE97C0DDCCC8D3EBA866D455779AD3E8FED5C96FCA3F23C0784902EA97F28`；
  win-unpacked 复核 3 项通过。未执行安装器真实安装流程（未验证项）。

# 三次复审修复（2026-09-08，对三次复审报告 N01–N02，提交 1dad8d4）

三次复审关闭 F01–F03；新增核心 5 项（3 过 2 败）+ 界面 2 项（均败）。
原始失败证据保留（results-needs-lifecycle-20260908-checked.json 与
.needs-lifecycle-ui-20260908-checked/ 输出目录）；修复后另存 -fixed。

## N01：纠正后旧条目退出待处理

三层修复：

1. `correct()` 事务内对被替代旧条目 `clearNeedsReasons` —— 纠正是用户
   动作，旧内容已由新结论替代，unconfirmed/conflict/manual/no_project
   全部清空。旧条目、纠正链、依据与历史保留，仅退出操作队列（L01/L02）。
2. Inbox 可处理范围排除 superseded：listItems 契约新增可选
   `excludeSuperseded`，Inbox 主查询启用；历史查询（理解页、改口历史）
   不受影响（LUI02）。
3. migration 10 定向清理本版本已产生的历史残留：只清
   `state='superseded' AND needs_review=1` 的行的原因集与标记，不触碰
   current/disputed 条目，不删除任何数据。L04 验证真实迁移执行器从 v8
   升到最新且幂等（断言改为「升到迁移账本最新版本」，不再固定数字）。

## N02：「暂不处理」改为真实搁置

按钮从 setPendingReview(false)（在原因集合模型下只剩「解除 manual 原因」
语义，无法表达暂缓）改为复用已有 shelveItem 能力：

- 暂缓有实际可见效果：条目移入 Inbox 下方「已搁置（暂不处理）」区，
  显示搁置时间，提供「恢复待讨论」按钮；
- 待处理原因与 confirmation=none 原样保留——不用确认/不采纳/删除冒充
  （LUI01 断言 confirmation 仍为 none）；
- 恢复后回到待讨论；重进页面与重启后搁置状态可理解、可恢复（LUI03：
  暂缓→重进→重启→恢复全程，原因与确认状态未被篡改）；
- 确认/不采纳/搁置/恢复操作失败均有错误反馈（ErrorBanner）。
- F01-a 语义未被破坏：setPendingReview(false)（明确解除）保持只清
  manual 原因，与搁置是两个不同动作。

## 验证

- needs-lifecycle 核心 5/5（L01/L02/L03-confirm/L03-reject/L04）。
- needs-lifecycle UI 3/3（LUI01/LUI02/LUI03，真实 Electron）。
- 回归：二次复审 round2 11/11、一次复审 recheck 11/11、project-audit
  15/15、历史 review 全部、核心集成 135/135；desktop e2e 16/16。
- verify 16 步全绿（新增 review-needs-lifecycle 与 -ui 两步）。
- 重新打包：122,598,699 字节，SHA-256
  `1DC8A631A7BCAD4D0FFC592E65C1F95A2F8C477277CFA3E2505742CF98B230F6`；
  win-unpacked 复核 3 项通过。未执行安装器真实安装流程（未验证项）。

# 修复收尾验收确认（2026-09-08，对修复收尾验收报告，提交 b8f216b）

收尾验收报告结论：N01/N02 通过关闭，未发现需继续返工的阻断性代码问题；
v0.2 定位为「工程修复验收通过，候选试用版；真实环境验收待完成」。

报告方独立执行：完整 verify 16 步、桌面 E2E 16/16、扩展 E2E、串联、
win-unpacked 复核 3/3、打包文件与重建产物逐字节一致（app.asar 内 6 个
文件 + 随包 MCP 入口）；另做 5 项独立补查全过（closure-b8f216b，覆盖
迁移 10 命中范围、纠正失败回滚、重开数据库不复活、搁置全原因逐字段
保留、Inbox 排除不影响历史查询）。

本轮修复 agent 仅做收尾两件事：

1. 5 项补查纳入默认 verify（review-closure 步骤）——完整 verify 17 步
   全绿；
2. REVIEW_PACKET 新增 0.20 节如实记录验收结论与定位。

无业务代码改动，无需重新打包（哈希 1DC8A631…F28 不变，且报告已核对
包内文件与重建产物逐字节一致）。

## 下一阶段（沿用既定门槛，未完成项）

1. 真实旧库升级与恢复（隔离副本 + 可恢复备份，对照升级前后关键记录）；
2. 真实安装/升级/卸载流程（安装器本身，非解包版代替）；
3. 真人完整使用闭环（真实 ChatGPT 采集→真实模型理解/纠正→真实编码
   客户端读背景/查证/执行/回写）。

三组都需用户确认测试环境、资料范围与费用后执行；在此之前不宣称
「v0.2 已完成全部实际验收」。v0.3 Door 方案可先整理，正式实施在
真实验收之后。

# v0.2.1 发布：GitHub 发版与自动更新（2026-09-08，用户需求第 1 项）

用户要求：正式软件更新通过 GitHub 发版（github.com/plnoble/OMNIX-IXAEON）
之后由软件自动检测更新。

## 实现

- electron-updater 接入（apps/desktop/src/main/updater.ts）：仅生产构建
  （app.isPackaged）启用；启动 5s 静默检查 + 设置页手动检查；自动下载、
  用户点击「重启并安装」（不自动重启——用户始终有控制权）；失败不阻塞
  使用。开发运行（非打包）不检查。
- electron-builder publish 指向 GitHub（plnoble/OMNIX-IXAEON）；产物含
  latest.yml（版本/SHA512/大小元数据，electron-updater 契约）。
- preload 暴露 window.ixaeonUpdates（check/install/onStatus 推送）；
  contracts 新增 UpdateStatusView。
- 设置页新增「应用更新」卡片（检查按钮/下载中/可安装/已是最新/失败原因）。
- 版本统一 0.2.1（全部 package/manifest/APP_VERSION/MCP serverInfo）。

## 验证（真实网络）

- 完整 verify 17 步全绿（0.2.1 版本下复跑）；desktop e2e 16/16、
  wizard 2/2。
- 打包 IXAEON-Setup-0.2.1.exe（122,833,959 字节，
  SHA-256 89E0F27DB6BBE93B0FBEBC4AD6290909683661247CD78A1151151EAD942473F3）。
- GitHub Release v0.2.1 已发布（含 exe + latest.yml + blockmap）；
  curl 实测 latest.yml 与安装包均可下载（HTTP 206）。
- win-unpacked 0.2.1 真实 Electron 启动 → 设置页更新卡片 → 手动检查 →
  真实访问 GitHub Releases → 正确返回「已是最新版本」（同版本无更新）。
  整条更新检查链路（网络/解析/版本比较/UI）真实验证。

## 已知边界（如实）

- 用户当前安装的 0.2.0 没有更新代码——首次升级到 0.2.1 需手动安装一次
  （Setup-0.2.1.exe）；此后（0.2.1+）的更新为自动检测。
- 自动更新只对生产构建生效；verify/e2e 环境无法覆盖真实下载安装路径
  （无更高版本可测），该路径待 0.2.2 发版时真机验证。

# v0.2.2 发布：首个真实用户实测反馈修复（2026-09-08）

用户在 A 组验收中反馈三个问题（另有一条未发完）：

## P1 文件夹导入（「一个项目这么多东西，怎么可以是一个文件说得明白」）

- core 新增 `ImportService.importFolder`：递归白名单（.md/.txt/.json）+
  排除规则（node_modules/.git/构建目录/点目录、密钥类文件名——与项目快照
  同一套规则）+ 单文件 10MB + 单目录 500 文件上限；逐文件失败隔离。
- IPC `importFolder`（目录票据 → folder 授权 → 核心层逐文件 importFile）；
  来源页新增「导入文件夹」按钮，完成摘要 + 跳过清单如实显示。
- 测试：3 项核心集成（递归/排除/失败隔离/去重/撤权拒绝）+ SRC01 真实
  Electron 界面（导入后 3 来源、排除内容不出现）。

## P2 分析失败（DeepSeek「模型结构化输出两次校验失败：items 应为数组」）

根因：提取只支持 OpenAI /responses 的 json_schema strict 约束；DeepSeek 等
/chat/completions 服务只有 json_object 模式，模型不知道目标 JSON 结构，
自创 `items` 为对象而非数组。

- `chatStructured` 把 zod→JSON Schema 附加到 system 提示（两端口统一生效）；
- 提取提示词 v2（EXTRACT_PROMPT_VERSION bump）：补输出格式说明、修正
  segment_ref 字段名（v1 写的 segment_id 与 schema 不一致）。
- 测试：modelProvider 单测 7 项（新增 schema 注入用例：无说明 → 复现用户
  失败；有说明 → 正确结构）。

## P3 重新分析入口（「没看到重新分析，也没看到确认/不采纳/纠正」）

说明：确认/不采纳/纠正不在来源页——它们在「理解」与「待讨论」页，作用于
提取出的条目；此前因 P2 分析失败无条目产生，所以什么都看不到（P2 修复后
自然出现）。来源详情页补常驻「重新分析」按钮（此前仅失败态有小字重试）。

## 验证与发布

- 完整 verify 17 步全绿；desktop e2e 16/16；sources 界面测试 2/2；
  打包产物复核 3/3。
- GitHub Release v0.2.2 已发布（IXAEON-Setup-0.2.2.exe，122,838,622 字节，
  SHA-256 2BE87ADD0A0BC4C5081A178921618FA26401AB31776ACA80A9282328AD152FC2）。
- 0.2.2 win-unpacked 真实 Electron 更新检查两次实测：网络闪断时如实显示
  「更新检查失败：net::ERR_CONNECTION_CLOSED（不影响当前使用）」；恢复后
  正确显示「当前已是最新版本」——错误反馈与正常路径都真实验证。
- 如实边界：已安装 0.2.0/0.2.1 的真实「下载→安装」升级路径仍待用户实机
  验证（0.2.0 需手动装一次）。
