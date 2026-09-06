# IXAEON v0.1 审核材料（REVIEW_PACKET）

> 按 `IXAEON_v0.1_开发计划.md` 第 12 章要求交付，并逐项回应
> `IXAEON_v0.1_验收问题与修复任务.md`（验收基线）、
> `IXAEON_v0.1_二次验收报告_2026-09-05.md`（R1–R9）、
> `IXAEON_v0.1_三次验收报告_2026-09-05.md`（N1–N6）、
> `IXAEON_v0.1_四次验收报告_2026-09-05.md`（F1–F4），并实施
> `IXAEON_下一阶段开发计划_v0.1.1到v0.2.md` 的 **M0 + M1 + M2 + M3 全部批次**，并逐项回应
> `IXAEON_v0.2_验收报告_2026-09-06.md`（G1–G8 + 材料缺口第 1 项 + 用户复核反馈）。
> 更新时间：2026-09-06（G1–G8 + M2 语义串联 + 复核反馈两处修复）。仓库：`D:\Agent\Project\OMNIX-IXAEON析衍`（分支 `main`）
>
> **声明**：本文件严格区分「自动化已验证 / 人工已验证 / 尚未验证 / 已知限制」。
> 每项声明附可复现命令或测试名。真实模型问答与真实 chatgpt.com 验收仍未执行（见第 11 节）。

---

## 0. 验收问题修复总览（对修复任务文档逐项）

| 问题                                      | 修复                                                                                                                                                                                                                                                                                                                           | 回归测试                                                                                                          | 状态                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| P1-3 安装版/开发版 MCP 配置不可用         | MCP 入口随包携带（extraResources → `resources/mcp/index.mjs`）；命令 = IXAEON.exe 自身（`ELECTRON_RUN_AS_NODE=1`），零全局 Node 依赖；开发版从 exe 位置向上实查 `apps/mcp/dist/index.mjs`（存在性校验）                                                                                                                        | desktop e2e「MCP 片段命令真实握手」从 win-unpacked 产物完成真实 STDIO initialize + tools/list                     | ✅ 自动化已验证                              |
| P1-4 问答/MCP 全文搜索失效 + 越过项目边界 | FTS 连接改 `sg.rowid = f.rowid`（askStore / mcpStore）；指定项目仅返回 `project_id` 严格相等资料（未分配不混入）；全局检索含未分配（规则记录于 privacy-model.md）；撤销授权来源不进任何检索；prepare_task 预算按序列化 JSON 长度核算                                                                                           | `fixes.test.ts`（FTS 原文检索 / A·B·未分配三向隔离 / 特殊字符不炸 SQL）+ mcp.test.ts                              | ✅ 自动化已验证                              |
| P1-5 渲染层可自伪造授权                   | 契约层删除 `allowedPaths`；改为**一次性授权票据**（pickFiles/pickSaveZip/pickRestoreZip 签发，5 分钟有效、单次使用、用途绑定）；核心层 ImportService 不再自行授权，必须传主进程创建的 permissionId（realpath 范围校验）；撤销后 8 个读取入口统一拒绝（阅读/上下文/搜索/问答/MCP segment 路径/MCP item 路径/重提取/vault 读取） | `fixes.test.ts`（伪造票据/A 授权读 B/符号链接逃逸/撤销全入口）+ desktop e2e「渲染层伪造路径导入被拒绝」           | ✅ 自动化已验证                              |
| P1-6 采集闭环不完整                       | `onCaptured` 接入（autoAnalyze=true 且域授权有效才排队，60s 防抖 + 任务表去重）；popup 新增「暂停/继续当前对话」（扩展本地拦截 + 服务端 403 双重强制）；`page:<hash>` → `/c/<id>` 身份合并（单一来源、不重复不丢内容）；同轮新指纹旧版转 `is_active_branch=0`；每次追加刷新 imported_at                                        | `localServer.test.ts` 9 项 + 扩展 e2e 暂停场景                                                                    | ✅ 自动化已验证                              |
| P1-7 导出不可读 + 恢复风险                | 导出增加 `data/*.json` 8 份人类可读文件（格式版本 + 稳定字段名）；恢复 = 临时目录全量校验（SQLite 头 / integrity / 迁移兼容 / raw_path 严格格式 + 布局一致 + vault 文件存在）→ 备份 rename（失败即中止，不吞异常）→ 原子替换 → 失败回滚；恢复必须持有 previewRestore 签发的一次性 previewToken                                 | `archiveFixes.test.ts` 8 项（凭证伪造/重复、恶意 raw_path、zip slip、未知条目、数据等价、备份失败回滚）           | ✅ 自动化已验证                              |
| P1-8 自定义数据目录丢设置                 | completeSetup 重构：先在新目录写全部数据（config 含加密 Key + localToken + 建库 + 首个项目）→ 全部成功后才切 bootstrap 指针；失败旧指针不动；API Key 仍走 safeStorage                                                                                                                                                          | 见已知限制 11.3（自动化覆盖核心层；完整 e2e 见下）                                                                | ✅ 自动化已验证（部分人工见 11.3）           |
| P1-9 日志保留正文 2000 字符               | 白名单式清洗：正文键（text/content/prompt/…/error/file 等 28 个）→ 仅长度+SHA-256 摘要；敏感键（token/apikey/…）同样摘要；Error/cause/message 递归；普通字符串上限 300；debug 级别同样清洗                                                                                                                                     | security.test.ts（开头/中间/结尾 + 独特短语全断言不存在）+ paths.test.ts                                          | ✅ 自动化已验证                              |
| P1-10 重提先删旧理解 + 分块不限长         | 提取改为「全部模型块成功 → 单短事务原子替换」；任一块失败旧 current 理解不变；Markdown/TXT 按标题/段落拆 segment（>6000 字符段继续安全切分）；单块完整 user 文本 ≤8000（含编号头）；splitTextToFit 保证可重组                                                                                                                  | `fixes.test.ts`（首块失败旧理解保留 / 原子替换 + superseded 不丢 / 30000 字符单段多块 / 多标题拆分 / 重组完整性） | ✅ 自动化已验证                              |
| P2-11 材料缺口                            | 真实文档语义验收（两份思想文档导入 + 六组问题检索 + 引用）；生成 `ixaeon-export-sample.zip`；12 张真实截图；端口 43120→43191 修正；本文件逐项标注验证方式                                                                                                                                                                      | `semanticAcceptance.test.ts` + screenshots.spec.ts + 扩展 e2e 截图                                                | ✅ 自动化已验证（真实模型问答除外，见 11.4） |

---

## 0.5 二次验收修复（对 `IXAEON_v0.1_二次验收报告_2026-09-05.md` R1–R9 逐项）

独立验收测试（`apps/desktop/test/review/review-20260905.test.ts`，11 项）修复前 11 项全部失败，
修复后 **11/11 通过**，并已纳入 `pnpm verify` 持续回归。审核提供的打包产物复核脚本
（`apps/desktop/test/review/packaged-20260905.mjs`）在重建后的 win-unpacked 上 **3 项检查全部通过**。

| 问题 | 修复 | 回归测试 | 状态 |
| --- | --- | --- | --- |
| R1 恢复凭证实例隔离 | previewToken 从 ArchiveService 实例 Map 移到**进程级注册表**（模块级 `restoreTokenStore`）：previewRestore（实例 A）签发、restoreData（实例 B）核销；一次性 + 10 分钟有效期 + 未预览拒绝规则不变 | review R1（真实 AppRuntime 预览→确认成功）+ archiveFixes「跨实例核销成功/二次使用失败」 | ✅ 自动化已验证 |
| R2 恢复失败回滚不完整 | restoreData 改为**按步骤精确回滚**（oldDbInBackup / oldVaultInBackup / newDbInstalled / newVaultInstalled 四个状态位）：先移开已安装的新数据，再把旧数据库与旧 vault **一起**还原；回滚失败明确报错并保留备份目录。AppRuntime 失败分支新增 `rebuildRuntimeServices()`：重开数据库 + 重建全部依赖服务 + 重绑 LocalServer（`rebindDeps`）+ 重启任务队列与 HTTP 服务 | review R2a/R2b（注入真实 rename 失败）+ 新增运行时重建由 e2e 链路验证 | ✅ 自动化已验证 |
| R3 撤销后仍有原文读取/模型发送 | `ItemService.getEvidence()` 对每个来源做 `assertSourceAuthorized`（撤销即整体拒绝）；提取器**每个模型请求前**重新检查授权（撤销后不再发送后续块）+ **提交新理解前**最终检查 | review R3a（撤销后序列化不含原文）/ R3b（4 次调用 → 1 次） | ✅ 自动化已验证 |
| R4 无效引用清空旧理解 | 引用/摘录校验改为**整次替换的前置条件**：任一无效引用（含虚构摘录）→ 明确抛错、旧理解不变；与「合法分析结果为空」（保持旧理解、0 inserted）区分。extraction.test.ts 旧「跳过后继续替换」断言已按新契约重写 | review R4 + extraction.test.ts「R4 契约」用例 | ✅ 自动化已验证 |
| R5 引用编号真实但摘录伪造 | 新增 `isExcerptGroundedInSegment`：摘录与片段文本做空白/引号规范化后必须子串匹配，模型自编摘录一律视为无效依据（触发 R4 的整次失败语义）；规则记录在 extractor.ts 注释 | review R5（FABRICATED_NOT_IN_SOURCE 不入库） | ✅ 自动化已验证 |
| R6 说话人角色丢失 | buildBlocks 组装块时保留片段真实 role（`[S1]（user）`/`（assistant）`），长段展开与重组同样保留，不再硬编码 doc | review R6（模型输入可识别 user/assistant） | ✅ 自动化已验证 |
| R7 60 秒窗口漏分析 | maybeAutoAnalyze 重写：窗口内新内容标记 pending 并安排**窗口结束后的补分析计时器**（每来源一个、多次变更合并）；补分析前复查采集开关/autoAnalyze/域授权；AppRuntime 入队不再因「已有排队/运行中任务」丢弃需求（提取幂等，最终状态=最新版本） | review R7（fake timers：窗口内新内容最终获得第 2 次分析回调） | ✅ 自动化已验证 |
| R8 误合并 + 暂停失效 | 合并候选判定 `isMergeCandidate`：a) 双方都有 sessionId 时必须一致；b) 缺 sessionId 时回退**完整包含检查**（临时来源全部片段必须在批次内）——仅首句相同绝不合并。扩展新增采集会话标识 `sessionId`（同标签页同对话跨 URL 转正保持，跨标签页/新对话必不同）。合并前若候选来源被暂停 → **暂停状态随身份转正迁移**并立即 403 | review R8a（两个来源）/ R8b（403 且内容未入库） | ✅ 自动化已验证 |
| R9 自定义目录勾选框误禁用 | AppState 新增 `envOverride` + `dataDirSource`（主进程按 resolveDataDir 真实解析返回）；Setup.tsx 改用 `state.envOverride`，不再用「目录字符串非空」推断 | review 打包脚本「custom directory checkbox without IXAEON_DATA_DIR override → ok, disabled:false」 | ✅ 自动化已验证 |

---

## 0.6 三次验收修复（对 `IXAEON_v0.1_三次验收报告_2026-09-05.md` N1–N6 逐项）

三轮审核的 13 项相邻场景检查（`apps/desktop/test/review/*round3.test.ts`）修复前
12 项失败（T9 正向对照通过），修复后 **13/13 通过**，并已纳入 `pnpm verify`
持续回归（verify 新增 review-round3 步骤）。报告确认上轮 R1–R9 的原始复现全部
保持解决。

| 问题 | 修复 | 回归测试 | 状态 |
| --- | --- | --- | --- |
| N1 会话编号未参与来源隔离 | ①创建来源时持久化 `sessionId` 到 metadata（T1 断言）；②来源查找增加会话比对：同 externalId 但 sessionId 不同 → 视为不同对话（T2 两个同路径标签页各自成源）；③合并候选判定：双方都有 sessionId 时必须一致（不再退化为「仅首句相同就合并」） | round3 T1/T2/T3 | ✅ 自动化已验证 |
| N2 转正后无法恢复采集 | 暂停状态绑定到稳定会话：config 新增 `pausedSessions`（按 sessionId）与 `sessionAliases`（externalId→sessionId，任何拒绝路径之前记录）；恢复操作清除该会话的全部有效别名（临时 ID + 正式 ID） | round3 T4（暂停→转正→明确继续→200 闭环） | ✅ 自动化已验证 |
| N3 补分析计时器不随暂停/恢复停止 | 计时器携带对话身份（externalId+sessionId），触发前复查该会话暂停状态；`pause-conversation` 时同步取消该会话的计时器与 pending；AppRuntime 恢复前与退出时调用 `localServer.stopBackgroundTasks()`（先停计时器再关数据库） | round3 T5（暂停后不再触发）/ T6（恢复后 61 秒无旧回调访问关闭的连接） | ✅ 自动化已验证 |
| N4 无效凭证后合法恢复 EBUSY | AppRuntime.restoreData 失败分类：关库之前的失败（凭证/预校验）→ 原运行时未被触动，直接复用（不叠加第二套服务、不重建） | round3 T7（无效凭证后仍是一套运行时/队列）/ T7b（随后合法恢复成功） | ✅ 自动化已验证 |
| N5 回滚未完成却新建空库 | archiveStore 回滚自身失败时抛出携带 `rollbackIncomplete` 标记的错误；AppRuntime 据此进入**恢复故障态**：不重建、不启动服务、不写数据；`rebuildRuntimeServices` 增加 `existsSync(dbPath)` 兜底，拒绝 openDatabase 静默建空库；日志如实记录备份位置 | round3 T8（双重注入失败：不建空库、不 startServer；T9 正向对照保持通过） | ✅ 自动化已验证 |
| N6 长段子块突破 8000 | buildBlocks 预算按「真实编号+角色头」计算并为后缀位数留余量，切分后用真实头逐一校验、超限收紧重切 | round3 T10（30,000 字符无换行 user 片段：所有完整块 ≤8000） | ✅ 自动化已验证 |
| T11/T12 客户端会话身份 | content.ts 弃用「正文超集」判据，改为**会话生命周期**：同 URL 同会话（编辑/重新生成不变）；formal→不同 formal 永远新会话；仅 page:→/c/ 且首条用户消息一致视为转正 | round3 T11（不同正式 URL 不同会话）/ T12（重新生成不变） | ✅ 自动化已验证 |

---

## 0.7 四次验收修复（对 `IXAEON_v0.1_四次验收报告_2026-09-05.md` F1–F4 逐项）

四轮审核的 7 项连续性检查（`apps/desktop/test/review/continuity-round4.test.ts`）
修复前 6 项失败（U7 正向对照通过），修复后 **7/7 通过**，已纳入 `pnpm verify`。
**放行条件 2 已完成**：新增真浏览器扩展 → 真实桌面本地服务 → 真实 SQLite 的
串联验收（`apps/extension/e2e/serial-real.cjs`，已接入 `pnpm test:e2e`），
覆盖真实配对码配对、正式对话采集、真实浏览器刷新（sessionId 必然变化）不重复
建档、追加内容增量入库、暂停/继续、SPA pushState 草稿转正合并。
身份与任务生命周期规则记录于 `docs/identity-lifecycle.md`。

| 问题 | 修复 | 回归测试 | 状态 |
| --- | --- | --- | --- |
| F1 页面采集会话被当成对话身份 | 身份模型重定义（docs/identity-lifecycle.md）：正式对话身份 = URL（任意 sessionId 落同一来源，U1/U2）；草稿身份 = sessionId，按「同路径 + metadata.sessionId 精确匹配」找回（草稿 A→B→A 各自归位，U3）；旧客户端无标识保守新建；建源+片段登记/建正式源+合并在同一事务（失败完整回滚，不留半成品） | round4 U1/U2/U3 + round3 全部（T1–T4 暂停/转正语义保持） | ✅ 自动化已验证 |
| F2 多草稿共用一个分析计时器 | 防抖/待分析/计时器全部改按 **sourceId**（稳定来源身份）而非临时网页地址；同来源多次更新仍合并，不同来源互不覆盖 | round4 U4（三个草稿全部获得补分析回调） | ✅ 自动化已验证 |
| F3 恢复拒绝后待分析工作消失 | `stopBackgroundTasks` 从凭证校验之前移入 `closeCurrentDb` 回调 —— 只有校验全部通过、即将替换磁盘时才停止后台任务；早期失败完整保留原运行时与待分析状态 | round4 U5（无效凭证拒绝后第二次分析仍发生）+ round3 T6/T7/T7b（恢复/凭证语义保持） | ✅ 自动化已验证 |
| F4 关闭自动分析后排队任务仍调模型 | 任务执行前复查（auto 任务：autoAnalyze、capture.enabled、来源授权、所属会话暂停；手动任务只查授权）；每个模型块前与结果提交前通过 `shouldContinue` 再复查；取消以 `cancelled` 状态落库（新增 IXA0023 JOB_CANCELLED，可见、可重试），不伪装成功 | round4 U6（关闭开关后 0 次模型调用）/ U7 对照（开启时正常执行成功） | ✅ 自动化已验证 |

---

## 0.8 M0 稳定性收尾（对《下一阶段开发计划》M0.1/M0.2）

按 [docs/identity-lifecycle.md](docs/identity-lifecycle.md) 的设计实施：
持久化版本三元组 + 暂时性失败退避重试 + 别名入库 + 启动扫描找回欠分析工作。

| 计划条目 | 实现 | 测试 | 状态 |
| --- | --- | --- | --- |
| M0.2 版本三元组 | 迁移 2 新增 `sources.content_revision / analyzed_revision`（导入=1、追加影响理解的内容递增、完全重复不递增；analyzed 只前进不回退，迁移旧行回填 1/1）；任务以「开始执行时版本」为目标，完成后守卫推进（`advanceAnalyzedRevision`），滞后自动补队 | m0-core「contentRevision 语义」+ m0-gates 门槛 1 | ✅ 自动化已验证 |
| M0.2 第 1 条 合并/去重 | 自动入队去重（同来源 queued/running 唯一，排除当前任务）；完成时版本滞后 → 补队一次 | m0-gates 门槛 1（运行中到达新版本 → 追平） | ✅ 自动化已验证 |
| M0.2 第 2/3 条 持久化待分析 + 崩溃恢复 | 「欠分析」= content > analyzed 持久化于 sources 表；启动时 `sweepPendingAnalysis()` 找回（网页来源受开关/授权/暂停复查，其他来源沿用导入管线语义） | m0-gates 门槛 2（窗口内退出重启 → 重启后追平） | ✅ 自动化已验证 |
| M0.2 第 4 条 执行时复查 | F4 已实现（U6/U7）；本轮接入取消信号 `shouldContinue` 于每块与提交前 | m0-gates 门槛 3（取消后不发新块、不提交、旧理解不变） | ✅ 自动化已验证 |
| M0.2 第 5 条 自动/手动分离 | F4 已实现（auto 标记 + autoGuardSatisfied；手动不受自动开关约束） | round4 U6/U7 | ✅ 自动化已验证 |
| M0.2 第 6 条 版本一致 | 目标版本在任务开始时锁定；analyzed 只前进（`WHERE analyzed_revision < target`），旧任务不能覆盖新结果 | m0-core「analyzed 只前进」 | ✅ 自动化已验证 |
| M0.2 第 7 条 有限重试 | JobQueue 对暂时性失败（MODEL_CALL_FAILED / SERVER_UNAVAILABLE / retriable ModelError）自动重试，默认 3 次、退避 5s/30s/120s（经 `jobs.not_before` 持久调度）；认证/预算/权限/校验/取消不重试；重试计数与错误入库可见 | m0-core 重试 2 项 | ✅ 自动化已验证 |
| M0.2 第 8 条 退出等待 | `stop()` 停止接收 → 等待在途任务结束（`jobs.idle()`）→ 关库；恢复失败不丢待处理（F3/U5 保持） | m0-gates 门槛 4 + round3 T6/T7/T8/T9 保持 | ✅ 自动化已验证 |
| M0.1 迁移 | 迁移 2 在旧库（仅迁移 1 + 数据）上验证：列补齐、行完整、回填策略明确（旧行标记 1/1，不批量触发补分析；需重分析可手动） | m0-core「旧库升级」 | ✅ 自动化已验证 |
| 附加修复 | sessionAliases 迁入 SQLite `session_aliases` 表（上限 500 裁剪）——修复每批采集重写整份 config.json 且别名无限增长的问题；恢复对话/重新开启开关后自动补齐欠分析（`onConversationResumed` / `sweepPendingAnalysis`） | round3 T1–T4 全部保持 | ✅ 自动化已验证 |

---

## 0.9 M1.2 展示真实状态（对《下一阶段开发计划》M1.2）

| 计划要求 | 实现 | 测试 | 状态 |
| --- | --- | --- | --- |
| 每来源可见：所属项目/最后收到时间/内容版本/已分析版本/最后成功分析时间/任务状态/错误原因 | 迁移 4 新增 `sources.analyzed_at`（最后成功分析时间，仅在 analyzed 前进时更新）；`SourceStore.list` 联查项目名与最近 extract 任务状态/错误；`SourceListItem` 契约新增 `projectName` + `analysis` 对象 | m1-status 4 项（等待分析/追平/欠分析可见/失败原因可见） | ✅ 自动化已验证 |
| 普通人文案 | Sources 表格新增「所属项目」与「状态」列，`analysisStatus()` 把版本差+任务状态映射为：已收到等待分析 / 正在分析… / 已分析最新内容 / 有新内容尚未分析，当前显示旧理解 / 自动分析已关闭 / 授权已撤销 / 分析失败可以重试（含错误摘要与重试按钮） | UI 渲染 + desktop e2e 全部保持通过 | ✅ 自动化已验证（文案映射） |
| 「收到资料」与「模型理解完成」不共用标记 | content_revision 与 analyzed_revision 分别记录；analyzed_at 独立于 imported_at | m1-status | ✅ 自动化已验证 |
| 状态刷新不靠切页、不调模型 | Sources 页 5 秒低频轮询（页面可见时才刷新，静默更新不闪烁） | desktop e2e 保持通过 | ✅ 自动化已验证 |
| 分析失败可重试 | 失败行内「重试」按钮调用已有 reextractSource（手动任务，不受自动开关约束） | UI + round4 U7 语义 | ✅ 自动化已验证 |

---

## 0.10 M2 重要理解可确认，改口不会被冲掉（对《下一阶段开发计划》M2）

| 计划要求 | 实现 | 测试 | 状态 |
| --- | --- | --- | --- |
| 三维度分离：谁提取的 / 用户是否确认 / 目前是否有效 | 迁移 5 新增 `items.confirmation（none/confirmed/rejected）+ confirmation_at`，与 `origin`（谁提取）、`state`（是否有效）正交；确认不把 AI 条目篡改为「用户写的」 | m2-confirmation「确认」 | ✅ 自动化已验证 |
| 确认/不采纳动作 | `ItemService.confirm/reject`（superseded 条目拒绝操作；清待讨论；留时间戳）+ IPC 审计（item.confirmed / item.rejected）+ Inbox「确认正确/不采纳/暂不处理」+ Understanding 徽章与动作按钮 | m2-confirmation | ✅ 自动化已验证 |
| 「不采纳」≠「确认正确」 | rejected 条目保留可追溯（state=current），但从 prepare_task 简报、问答上下文、search_context 条目检索中排除 | m2-confirmation「简报排除」 | ✅ 自动化已验证 |
| 人工改口优先 | 重新提取时：已确认/已不采纳条目不删除（deleteOldAiItems 加 confirmation='none' 条件）；新结论与它们高度相似（Jaccard bigram ≥0.6）→ 跳过并计 `skippedPreserved` —— 不复活已否决建议、不重复已确认结论 | m2-confirmation「重新提取不冲掉改口」 | ✅ 自动化已验证 |
| 冲突真的可见 | Understanding 页查询不再只取 current 再筛 disputed —— disputed 与 current 一起取回并分组展示（「存在冲突的结论」卡片） | UI 查询路径 + m2-confirmation | ✅ 自动化已验证 |
| 审批负担控制 | 普通有依据 AI 理解自动产生并明确标记（origin=ai）；未归属/冲突仍进待讨论（needs_review）；用户确认/不采纳后退出待讨论 | m1-binding + m2-confirmation | ✅ 自动化已验证 |

---

## 0.11 M3 编码 AI 的开工与收工闭环（对《下一阶段开发计划》M3）

| 计划要求 | 实现 | 测试 | 状态 |
| --- | --- | --- | --- |
| 简报区分 AI 提取 / 用户确认·纠正 / 编码 agent 自报 | BriefingEntry 新增 `origin（ai/user/work_result）`：条目带真实 origin，recent_work 固定 work_result；MCP 初始化说明新增第 7 条规则（agent 自报 ≠ 用户验收） | m3-loop「简报区分来源」 | ✅ 自动化已验证 |
| 标明覆盖到哪个内容/分析版本；新内容未分析时简报明确「可能落后」 | prepareTask 输出新增 `coverage { maxContentRevision, maxAnalyzedRevision, hasUnanalyzedContent }`；hasUnanalyzedContent 时 staleness_notice 追加明确提示 | m3-loop「覆盖版本」×2 | ✅ 自动化已验证 |
| 回写幂等：相同请求重试不产生重复 work_run；同键不同内容报冲突；旧客户端兼容 | 迁移 6 `work_runs.client_ref`（部分唯一索引）；`record_work_result` 可选 `client_ref`：相同键同内容 → 返回 `deduplicated: true` 且不重复入库；同键不同内容 → CONFLICT 明确报错；不传时维持原行为 | m3-loop「幂等」×3 | ✅ 自动化已验证 |
| 旧四工具旧输入仍有效；新增字段有契约测试 | 旧输入全部通过（mcp.test 10 项 + 四轮独立回归 31 项保持）；新字段 schema 于 contracts（client_ref/deduplicated/coverage/origin） | 契约 + 回归 | ✅ 自动化已验证 |
| 独立 MCP 客户端进程走完闭环（不预塞背景） | 安装版 MCP 复核脚本（packaged-20260905.mjs 第 3 项）：独立进程 STDIO 握手 + 四工具真实调用 + 写回持久化，在新产物上通过 | 打包复核 | ✅ 自动化已验证（FakeProvider 语义层面） |
| 真实编码 AI 客户端验证 | 需用户可用客户端与授权（计划 M3 验收第 2 项）；未执行，如实标注 | — | ⏳ 未验证（见第 11 节） |

---

## 0.12 v0.2 验收修复（对 `IXAEON_v0.2_验收报告_2026-09-06.md` G1–G8 逐项）

15 项针对性检查（`apps/desktop/test/review/v02-acceptance-20260906.test.ts`）修复前
14 项失败（V15 正向对照通过），修复后 **15/15 通过**，已纳入 `pnpm verify`。
按报告要求更新了 4 处旧断言（迁移回填/重要决定待确认/相似结论处理/归属断言）——
均为新契约的如实适配，未削弱业务要求。

| 问题 | 修复 | 测试 | 状态 |
| --- | --- | --- | --- |
| G1 任务标取消结果仍写入 | 真实取消信号（ctx.signal）与自动开关/暂停检查**组合**注入提取器（手动任务同样受约束）；提交后若已中止 → 抛 JOB_CANCELLED，不推进 analyzed、不入库 | V01 | ✅ |
| G2 崩溃遗留 running 任务永久阻塞 | sweepPendingAnalysis 启动阶段将无执行者的 running 任务转 queued（保留重试预算，记审计）；恢复受开关/权限/暂停复查 | V02 | ✅ |
| G3a 切回旧分支不更新版本 | 旧指纹重新激活 = 「当前有效内容变化」（非无变化重复）→ 递增 content_revision 进待分析 | V03 | ✅ |
| G3b coverage 跨来源误判追平 | 按「每个来源」检查版本差再聚合（SUM pending>0）；staleness_notice 指明落后来源数 | V04 | ✅ |
| G3c 迁移伪造已分析 | 迁移 7：无 items 且无 succeeded 任务的来源 analyzed 回退 0（按成功证据判定）；迁移不调用模型，补分析由启动扫描按开关控制 | V05 | ✅ |
| G4 纠正失效/反向意见被丢 | 保护集扩展：superseded（被纠正前驱）+ confirmed/rejected + origin=user 全链；**字符相似只作候选信号**——完全相同才跳过，相似但不相同 → 入库并 needs_review（可见冲突，不替用户选边） | V06/V07 | ✅ |
| G5 单独归属被搬/在途写旧项目 | 迁移 8 `items.manual_project`：人工 assignToProject 置 1，来源级批量重绑不搬；提取器提交前重验来源归属，以提交时点归属入库 | V08/V09 | ✅ |
| G6 重要决定绕过待确认 | decision/rejected_option/project_summary 且未确认 → needs_review=1（与项目归属正交）；简报该类条目标「（待用户确认）」并同步进 risks 组 | V10 | ✅ |
| G7 幂等丢项目/提交差异、破坏引用契约 | client_ref 与内部 ID 分开保存（work_run_id 恒为 UUID，长度契约不破坏）；比较含解析后项目 ID + commit_ref + 全字段——跨项目/不同 commit → CONFLICT | V11/V12/V13 | ✅ |
| G8 简报完整输出超预算 | 预算按**完整序列化输出**核算（含任务/项目/coverage/时间/提示/JSON 容器）：条目粗裁 → 完整复核 → 仍超限按优先级（work→status→rejected→loops→decisions）逐条移除再复核；待确认/过期提示不优先裁 | V14 | ✅ |

---

## 0.13 M2 六类语义资料串联验收（补齐 v0.2 验收报告第四节材料缺口第 1 项）

报告原文：「M2 计划要求的六类固定语义资料，在界面、持久化、MCP 输出之间的串联验收。
当前仍未完整交付；这部分可以先用合成资料与 FakeProvider 自动化，不必等待真实 Key。」

补齐交付：

- **固定资料集**：`packages/test-fixtures/src/index.ts` 新增 `M2_SCENARIOS`（S1–S6）——
  AI 提议未答应 / 用户明确否决 / 用户后来改口 / 不同来源矛盾 / 证据不足 /
  agent 声称完成未验收。每类含原文、模型提取输出、用户动作、**先行的预期判据**
  （持久化 + 简报），供自动化回归与真实模型验收共用。
- **串联验收**：`packages/core/test/integration/m2-semantics.test.ts`（7 项）——
  每组走「导入 → 提取 → 用户动作（确认/不采纳/纠正）→（次轮追加或第二来源）→
  断言 items 持久化状态 + prepare_task 简报输出」：
  - S1 未答应的决定带「待用户确认」标注（不混成已拍板）；
  - S2 否决条目从简报排除但持久化保留可追溯；
  - S3 改口后旧决定 superseded、新结论 current 且简报带「用户确认」、
    旧决定重提不复活；
  - S4 矛盾结论入库待讨论、简报可见「待用户确认」；
  - S5/S6 open_loop 正常流转；
  - S6 附加：agent 自报工作 origin=work_result（不等于用户验收）。
- **界面断言说明**：界面层（Inbox/Understanding）与这些状态消费同一 IPC 数据源
  （listItems 含 confirmation/needs_review 字段，页面渲染逻辑由 desktop e2e
  覆盖）；串联断言聚焦持久化+MCP 输出两端，与报告要求的三层中可自动化部分对应。

| 测试 | 结果 |
| --- | --- |
| m2-semantics 7 项（S1–S6 + S6 附加） | ✅ 全部通过，纳入 verify（integration 计入） |

---

## 0.14 用户复核反馈修复（2026-09-06 复核两处缺口）

| 反馈 | 修复 | 回归测试 | 状态 |
| --- | --- | --- | --- |
| 切回旧回答不会自动重新分析（版本号更新但 accepted=0 被跳过——知道内容变了却未必开始处理） | `appendCapturedTurns` 返回值增加 `branchSwitched`；采集路径以「内容是否变化」（新增片段 **或** 分支切换）判断是否排队分析，不再只看 accepted 数 | review-followup「分支切换后分析必然触发」（fake timers：切换后推进防抖窗口 → onCaptured 被调用、content_revision 递增） | ✅ 自动化已验证 |
| 重新提取仍会删除人工分配过项目的条目（G5 只保护了来源级改绑路径） | `deleteOldAiItems` 增加 `manual_project = 0` 条件——人工单独分配过项目的 AI 条目与确认/不采纳同属人工决定保护，重提不删除 | review-followup「manual_project=1 的条目重提后保留」 | ✅ 自动化已验证 |

对第三点反馈的回应：六类场景原有测试验证「数据持久化 + MCP 简报」两端；
**逐类实际操作界面**已补 Playwright 界面级场景（`apps/desktop/e2e/m2-ui.spec.ts`，
4 项）：真实 Electron 窗口内导入六类资料、操作来源/理解/待讨论页面、验证
空态与失败态如实展示（未分析不伪装已分析）、agent 回写后最近工作在项目页
可见且不混入当前理解。**真实模型理解能力**仍属发版门槛的真人验收（判据
已备好于 M2_SCENARIOS），如实列入未验证项。

---

## 1. 完成范围

### 实际完成（M0 → M5 全部 + 验收修复）

| 里程碑 | 范围                                                                                                                       | 状态 | Commit       |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ---- | ------------ |
| M0     | monorepo 骨架（contracts / core / test-fixtures / desktop / mcp / extension）、SQLite migration、日志、错误码、verify 脚本 | ✅   | `2708585`    |
| M1     | 原文仓库（vault + SHA-256）、导入、权限、桌面应用全页面、e2e 冒烟                                                          | ✅   | `c113247`    |
| M2     | ModelProvider、OpenAI Responses 客户端、结构化提取、项目卡、纠正、Inbox、问答                                              | ✅   | `214a255`    |
| M3     | MCP 闭环（4 工具 + 本地端点 + STDIO 转发 + 配置文档）                                                                      | ✅   | `5d970ae`    |
| M4     | ChatGPT 网页扩展（增量采集 + 配对 + 流式稳定）                                                                             | ✅   | `810038d`    |
| M5     | 导出/恢复、安全/性能验证、NSIS 安装包、首版 REVIEW_PACKET                                                                  | ✅   | `21376ed`    |
| 修复   | 本轮验收问题修复（P1×8 + P2-11），见第 0 节                                                                                | ✅   | （本次提交） |

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
  ✓ lint（ESLint） 通过
  ✓ format:check（Prettier） 通过
  ✓ typecheck（tsc --noEmit） 通过
  ✓ unit（Vitest） 通过 —— 16 passed
  ✓ integration（Vitest） 通过 —— 98 passed
      db 6 / import 13 / extraction 10 / mcp 10 / archive 11 / security 8 /
      performance 4 / fixes 15 / archiveFixes 8 / semanticAcceptance 4 /
      localServer 9
  ✓ review（二次验收独立业务测试） 通过 —— 11 passed（R1–R9 回归，已纳入 verify）
  ✓ review-round3（三次验收相邻场景） 通过 —— 13 passed（N1–N6 回归，已纳入 verify）
  ✓ review-round4（四次验收连续性） 通过 —— 7 passed（F1–F4 回归，已纳入 verify）
  ✓ review-v02（v0.2 验收） 通过 —— 15 passed（G1–G8 回归，已纳入 verify）
  ✓ integration 追加 M0 收尾回归 —— m0-core 4 项（迁移/版本/重试）+ m0-gates 4 项（M0 门槛）
  ✓ build（desktop / mcp / extension） 通过

corepack pnpm test:e2e
  desktop e2e：10 passed（Playwright + Electron；含 MCP 真实 STDIO 握手、
              票据伪造拒绝、MCP 端点真实 prepare_task + record_work_result、
              9 页面截图采集）
  extension e2e：全部断言通过（真实 Chromium + 真实扩展 + mock chatgpt.com；
              含暂停/继续当前对话闭环、会话标识提交）

serial e2e（串联验收，`pnpm test:e2e` 第三阶段；真扩展 → 真实服务 → 真库）：
  ✓ 真实配对码配对 ✓ 正式对话采集入库 ✓ 真实浏览器刷新不重复建档且
    sourceId 不变 ✓ 追加内容增量入库 ✓ 暂停后不入库/继续后恢复 ✓
    SPA pushState 草稿转正合并（临时来源消失、来源总数正确）

打包产物复核（审核提供的 apps/desktop/test/review/packaged-20260905.mjs）：
  ✓ R9：无 IXAEON_DATA_DIR 时自定义目录勾选框可用（disabled:false）
  ✓ 后端自定义目录保存 + 完整进程重启 + 项目保留
  ✓ 搬迁后的 win-unpacked 产物 + 隔离 APPDATA + 仅 System32 的 PATH：
    STDIO 握手 + 四工具真实调用 + 写回持久化

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
  - 导出 ZIP = manifest + readme + **data/\*.json 8 份人类可读** + db.sqlite + vault/
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

| 文件                       | 内容                                            |
| -------------------------- | ----------------------------------------------- |
| 01-setup.png               | 首次设置向导（数据目录步骤）                    |
| 02-sources.png             | 来源页（导入后列表）                            |
| 03-source-detail.png       | 来源详情（片段阅读器）                          |
| 04-search.png              | 检索页（命中结果）                              |
| 05-projects.png            | 项目页                                          |
| 06-understanding.png       | 理解页                                          |
| 07-ask.png                 | 问答页                                          |
| 08-settings.png            | 设置页（模型 / 采集开关 / MCP 片段 / 导出恢复） |
| 09-overview.png            | 总览（服务 127.0.0.1:43191）                    |
| 10-extension-pair.png      | 扩展弹窗（配对输入）                            |
| 11-extension-connected.png | 扩展弹窗（已配对 + 状态）                       |
| 12-extension-paused.png    | 扩展弹窗（当前对话已暂停 + 继续按钮）           |

---

## 7. 网络请求目标清单（全部）

| 目标                                  | 用途                        | 何时发生                             |
| ------------------------------------- | --------------------------- | ------------------------------------ |
| `https://api.openai.com/v1/responses` | OpenAI Responses 模型调用   | 仅用户配置 API Key 并触发提取/问答   |
| `127.0.0.1:43191`（本地回环）         | 扩展 ↔ 桌面端、MCP ↔ 桌面端 | 本机进程间                           |
| 无其他目标                            | —                           | 静态扫描测试强制（security.test.ts） |

- 扩展只访问 chatgpt.com DOM + 127.0.0.1；MCP 只访问 127.0.0.1。
- 无遥测、无更新检查（publish: null）、无崩溃上报。
- （修正说明：旧版 REVIEW_PACKET 两处误写端口 43120，实际固定端口为 **43191**。）

---

## 8. 依赖与许可证

| 依赖                                        | 版本        | 许可证         | 用途                              |
| ------------------------------------------- | ----------- | -------------- | --------------------------------- |
| electron                                    | 44.1.1      | MIT            | 桌面壳（兼作 MCP 的 Node 运行时） |
| react / react-dom                           | 19.2.x      | MIT            | 渲染层                            |
| vite / electron-vite / @vitejs/plugin-react | 7 / 5 / 5   | MIT            | 构建                              |
| better-sqlite3                              | 13.0.3      | MIT            | 存储（N-API）                     |
| fastify                                     | 5.12.1      | MIT            | 本地 HTTP                         |
| jszip                                       | 3.10.1      | MIT/Apache-2.0 | 导出/恢复                         |
| zod                                         | 4.5.4       | MIT            | 契约校验                          |
| @modelcontextprotocol/sdk                   | 1.30.0      | MIT            | MCP STDIO                         |
| playwright / @playwright/test               | 1.62.1      | Apache-2.0     | e2e                               |
| vitest                                      | 4.1.11      | MIT            | 测试                              |
| eslint / prettier / typescript              | 见 lockfile | MIT            | 工具链                            |

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
3. **自定义数据目录**：R9 界面禁用缺陷已修复（勾选框由主进程 envOverride 控制，
   打包产物复核通过）；后端「自定义目录保存 + 完整进程重启 + 项目保留」已由审核
   打包复核脚本在产物上验证通过。数据目录解析优先级（env > bootstrap > 默认）。
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
- 安装包：`apps/desktop/release/IXAEON-Setup-0.1.0.exe`（复核反馈修复后重建）
  - 大小：122,587,174 字节（≈116.9 MB）
  - SHA-256：`F8307ACFC511A8DBA9069B5CEBA75F3781CF4F68DFA764B6C9E2F0A9FC57C196`
  - 随包携带 `resources/mcp/index.mjs`（搬迁副本 + 仅 System32 PATH 下完成
    STDIO 握手与四工具真实调用，见打包产物复核）
- 导出样例：`apps/desktop/release/ixaeon-export-sample.zip`（含两份思想文档真实数据）
- 语义验收记录：`apps/desktop/release/semantic-acceptance.json`
- 截图：`apps/desktop/release/screenshots/`（12 张）
- 审核材料：本文件
- 配置文档：`docs/mcp-setup.md`（Codex / Claude Code / Cursor）
- 开发过程记录：`docs/dev-log-fixes.md`（两轮修复，含二轮 R1–R9）

---

## 附录：打包环境网络说明

同前版（Electron 镜像 / NSIS 手动缓存方案），干净网络环境无需以上步骤。
