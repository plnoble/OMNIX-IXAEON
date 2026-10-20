# C3a 门禁先量再分（不删）交付

- 分支：`grok/C3a`，基于 main `c870e42`；档位 **A**（只交这一份分析：不改 `scripts/verify.mjs`、不删不改任何测试、不动 CI）
- 执行方：grok

## 已实现

只做两件事：**量**和**分**。

- 量：在 `D:\Agent\Worktrees\IXAEON\ops`（操作目录，停在 `origin/main` = `c870e42`，工作区干净）把 `node scripts/verify.mjs` **一次一次跑了 3 遍**（三次之间不跑别的东西），用门禁自己打印的每步用时取中位数。原始日志：`.logs/verify-c3a-1.log`、`-2.log`、`-3.log`（工作目录内，不入库）。
- 分：把门禁里按审核编号命名的 **23 个回归步骤**（19 个 vitest 套件 + 4 个真 Electron 界面套件）逐个读了一遍，写下「测了什么」「有没有锁定验收测试管着同一件事」「功能还在不在」，然后归成 保留 / 可以并进 / 可以删。

改动文件：无（本单不改仓库里的任何文件，只加这一份交付说明）。

## 量出来的结果

三次都是 exit 0（全绿）：**259.9s / 195.6s / 197.5s**，中位数合计 **198.7s（约 3 分 19 秒）**。

先说两个和规格不一样的数，后面分类要用：

- 规格写「`node scripts/verify.mjs` 是 35 步，本机跑一遍十来分钟」。**现在是 32 步、约 3 分 19 秒**（`docs/委派/C3a-门禁先量再分.md` 是 2026-10-19 之前写的，门禁在那之后变过）。「十来分钟」大概是几台机器/杀毒在跑时的数——本机这三次最快 3 分 16 秒、最慢 4 分 20 秒（第一次最慢，是 integration 那一步 65.2s 对后面两次 25.6s，典型的本机抖动）。
- 规格写「27 套按审核编号命名的回归套件」。**现在是 23 步**（19 个 vitest 套件 + 4 个 playwright 界面套件），其中 `review-p0-f71da15`、`review-recheck-round2`、`review-direction-merged` 三步各自跑 2–3 个测试文件。

### 每一步：做什么、三次用时、中位数、CI 跑不跑

CI（`.github/workflows/verify.yml`）只有一个「门禁（与本机 node scripts/verify.mjs 相同）」步骤直接跑 `node scripts/verify.mjs`，所以**下面每一步在 CI 上都会被执行**（外加一步 `node scripts/test-e2e.mjs desktop`）。但「被执行」不等于「检查在 CI 上真起作用」——**`local-user` 那一步是例外**：它查的是「跟踪的文件里有没有本机账户名」，CI 上的账户名是公用的（`runneradmin` 之类），查不出开发机的东西（AGENTS.md 也写了「只在本机拦得住」）。所以第 3 行写「跑（CI 上等于不查）」，别的行才是「跑」。（第 2 轮审查指出这一点，已改。）

| # | 步骤（门禁打印的名字） | 做什么 | 三次用时（s） | 中位数（s） | CI 跑不跑 |
| --- | --- | --- | --- | --- | --- |
| 1 | lint（ESLint） | 全仓 ESLint | 6.4 / 6.2 / 6.1 | 6.2 | 跑 |
| 2 | format:check（Prettier） | 检查格式（`apps/*/src`、`packages/*/src`、`scripts/**/*.mjs`、根 `*.{ts,mjs,json}`） | 3.5 / 3.3 / 3.1 | 3.3 | 跑 |
| 3 | local-user（提交的文件里没有本机的账户名） | 查跟踪的文件里有没有本机账户名（只在开发机拦得住） | 0.3 / 0.3 / 0.2 | 0.3 | 跑（CI 上等于不查） |
| 4 | typecheck（tsc --noEmit） | 全仓类型检查 | 5.7 / 5.3 / 5.1 | 5.3 | 跑 |
| 5 | build（desktop / mcp / extension） | 构建三端产物（后面的界面步骤依赖它） | 8.4 / 7.5 / 7.7 | 7.7 | 跑 |
| 6 | unit（Vitest 单元测试） | `--project unit` | 5.1 / 3.6 / 3.7 | 3.7 | 跑 |
| 7 | integration（Vitest 集成测试） | `--project integration` | 65.2 / 25.7 / 25.6 | 25.7 | 跑 |
| 8 | acceptance-lock（锁定的验收测试没被改） | 核对 `docs/委派/锁定验收.json` 的指纹 | 0.1 / 0.1 / 0.1 | 0.1 | 跑 |
| 9 | acceptance（已完成任务的锁定验收测试） | 跑已完成任务的锁定验收（84 文件 / 709 条） | 70.9 / 62.6 / 62.6 | 62.6 | 跑 |
| 10 | review（二次验收独立业务测试 11 项，修复 R1-R9 回归） | 二次验收的反例：恢复令牌、回滚原子性、撤销期间的提炼、证据引用、角色保留 | 3.2 / 2.8 / 3.0 | 3.0 | 跑 |
| 11 | review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） | 会话身份（草稿/正式）+ 生命周期相邻场景 | 4.5 / 4.0 / 4.0 | 4.0 | 跑 |
| 12 | review-round4（四次验收连续性 7 项，修复 F1-F4 回归） | 刷新/重开/切草稿的连续性、autoAnalyze 关掉后的排队提炼 | 3.1 / 2.5 / 2.6 | 2.6 | 跑 |
| 13 | review-v02（v0.2 验收 15 项，修复 G1-G8 回归） | v0.2 反例：队列取消、孤儿任务、修订号、旧库升级标记、纠正复活、矛盾、来源移动、待复核、幂等键 | 3.2 / 2.8 / 2.7 | 2.8 | 跑 |
| 14 | review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） | 工具范围（H01-H05）、记忆边界（M01/M03）、验证范围（E01-E03）、技能/研究边界 | 3.9 / 3.4 / 3.4 | 3.4 | 跑 |
| 15 | review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） | TinyFish/搜索契约、技能证据、看门狗 | 3.2 / 2.9 / 2.8 | 2.9 | 跑 |
| 16 | review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） | P0 边界 + MCP/搜索权限 | 4.6 / 3.9 / 3.8 | 3.9 | 跑 |
| 17 | review-p1-action-loop（P1-A 目标驱动桌面办事闭环 4 项） | 目标→产物闭环 | 3.1 / 2.6 / 2.5 | 2.6 | 跑 |
| 18 | review-p1-memory-projects（P1-B 记忆与 P1-C 三项目统筹 7 项） | 自动分寸记忆、跨项目统筹 | 2.5 / 2.1 / 2.0 | 2.1 | 跑 |
| 19 | review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） | 研究去重、方法复用 | 3.0 / 2.4 / 2.6 | 2.6 | 跑 |
| 20 | review-p2（P2 受控实验与安全回滚 5 项） | 受控实验、安全回滚 | 2.6 / 2.0 / 2.1 | 2.1 | 跑 |
| 21 | review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） | 连接器生命周期 | 3.1 / 2.0 / 2.0 | 2.0 | 跑 |
| 22 | review-p3a-connector-registry（P3-A 连接器注册表 6 项） | 注册表游标/覆盖/失败/撤销/导入接线 | 2.3 / 2.0 / 2.1 | 2.1 | 跑 |
| 23 | review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） | 方向质量 RQ01-RQ17 + 复审 C01-C10 + 二轮 R01-R09 | 6.1 / 5.1 / 5.3 | 5.3 | 跑 |
| 24 | review-project-audit（全项目审核 15 项，修复 C01-C13 回归） | 全项目审核 A01-A15 | 3.3 / 2.7 / 2.8 | 2.8 | 跑 |
| 25 | review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） | 复审反例 B01-B10（含密钥存储） | 3.8 / 3.2 / 3.6 | 3.6 | 跑 |
| 26 | review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） | 二次复审 + 迁移 8→9 回填（`f01-migration`） | 3.5 / 2.7 / 3.1 | 3.1 | 跑 |
| 27 | review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） | 纠正退休前任原因、迁移器幂等 | 2.3 / 2.0 / 2.1 | 2.1 | 跑 |
| 28 | review-closure（修复收尾验收 5 项） | 迁移命中范围、回滚、重开库、原因保留、查询边界 | 2.3 / 2.0 / 2.2 | 2.2 | 跑 |
| 29 | review-needs-lifecycle-ui（LUI01-LUI03，真实 Electron） | 生命周期界面 | 8.7 / 7.2 / 7.6 | 7.6 | 跑 |
| 30 | review-understanding-ui（UND01-UND02，真实 Electron） | 理解页界面 | 6.5 / 6.0 / 6.2 | 6.2 | 跑 |
| 31 | review-sources-wizard-ui（SRC01-02 + WIZ01-02，真实 Electron） | 来源页 + 首次向导界面 | 7.8 / 7.4 / 7.5 | 7.5 | 跑 |
| 32 | review-recheck-ui（UI01 + BUI01 + BUI02，真实 Electron） | 复审界面 | 7.7 / 7.3 / 7.3 | 7.3 | 跑 |

合计：9 个非回归步骤 **114.9s**（lint…acceptance），19 个 vitest 回归步骤 **55.2s**，4 个界面回归步骤 **28.6s**。

## 23 个回归步骤：测了什么、分类、理由

分类口径照规格：**保留**（没有别的测试管着、管的东西还重要）/ **可以并进**某处 / **可以删**（写清依据）。

「按主题最接近的锁定验收用例」这一列是照规格第 3 步查的：`docs/委派/锁定验收.json` 里 52 个已完成任务、每条登记了锁定测试文件，逐个套件去找**主题上最近的那一条**。查到的情况一句话：**没有一条找到了「覆盖」证据**——锁定里多数是「这个功能该有的行为」（正例），这 23 步里绝大多数是「这个坏情况不该发生」（反例）；所以下面每行写的是「主题上最接近」，**不是「覆盖」，也不是「同一条断言」**（第 1、2 轮审查都提醒过这个区别，界限见本节末尾「可以删」那一段）。

| # | 门禁步骤 | 测试文件（`apps/desktop/test/review/`） | 测了什么（一句话） | 按主题最接近的锁定验收用例（不是覆盖证明） | 分类与理由 |
| --- | --- | --- | --- | --- | --- |
| 10 | review | `review-20260905.test.ts`（11 项，R1-R8b） | 恢复/回滚的原子性：恢复失败不重建、回滚不丢待分析、撤销期间不提炼、证据引用不泄漏、角色保留、尾随自动分析、对话合并 | R1「恢复失败后重建聊天」`apps/desktop/test/acceptance/r1-rebuild-conversations-semantic.test.ts`、G01「会话重建后补历史」`packages/core/test/acceptance/g01-session-rebuild.test.ts`（都是正例：重建该怎么做；这套管的是「失败时不许重建、回滚不许丢东西」） | 可以并进「早期审核反例」：与 11/12/13/24/25/26/27/28 同一批服务（ItemService/PermissionService/Vault/SourceStore）的相邻反例，一次 vitest 启动就能全跑 |
| 11 | review-round3 | `identity-round3.test.ts`（2 项）、`lifecycle-round3.test.ts`（11 项，N1-N6） | 草稿/正式会话身份不被混同；暂停/恢复/回滚/8000 字拆分 | G01、G06「对话的项目固定」`apps/desktop/test/acceptance/g06-conversation-project.test.ts` | 可以并进「早期审核反例」：同上；`identity-round3` 只有 2 项，单独一个进程不划算 |
| 12 | review-round4 | `continuity-round4.test.ts`（7 项，F1-F4） | 刷新/重开/切草稿的连续性、关掉 autoAnalyze 后排队提炼不再调模型（含对照） | G06、A4「切回来接着看还在写的回答」`apps/desktop/test/acceptance/a4-follow-live.test.ts`、R1 | 可以并进「早期审核反例」：同上 |
| 13 | review-v02 | `v02-acceptance-20260906.test.ts`（15 项，G1-G8） | 队列取消、孤儿任务、内容修订号、v1 库升级不得标成已分析、纠正不得复活、矛盾不得被丢、来源移动/换项目、待复核、幂等键跨项目 | A1「分析失败耐心重试」`packages/core/test/acceptance/a1-patient-retry.test.ts`、A2「迁移前自动备份」`…/a2-backup-before-migrate.test.ts`、X1、N2 | 可以并进「早期审核反例」：同上 |
| 14 | review-restructure | `restructure-20260913.test.ts`（15 项，A01-A05/A07-A09） | 工具边界 H01-H05（越界写、exit-0 冒充验证、漏跑第二条命令）、记忆边界 M01/M03、验证范围 E01-E03 | D7「只发批准范围内的文件、只改批准范围内的」`packages/core/test/acceptance/d7-model-executor.test.ts`、V3「零依赖档跑的程序连不出去」`…/v3-verify-no-network.test.ts`、D2「独立验证按档位进沙箱」`…/d2-*.test.ts`（正例都在；「越界写能不能得逞」「exit-0 能不能冒充验证」只有这套和 23 在管） | 保留（并进「边界与方向」也可以）：这套管**授权边界**，别处没有等价反例 |
| 15 | review-bbe651f | `review-bbe651f-20260915.test.ts`（14 项，Q01-Q07） | 搜索/TinyFish 契约、技能证据门槛、看门狗、分数与来源 | G07「搜索预算按天恢复」`…/g07-daily-budget.test.ts` 等 3 份、W1a「关注方向」、P3「项目进展简报」 | 保留：外部契约类反例，锁定里没有对应条目 |
| 16 | review-p0-f71da15 | `review-p0-boundaries-20260916.test.ts`（12 项）、`review-f71da15-20260916.test.ts`（7 项） | P0 可信基础边界 + MCP/搜索权限 + F02-F06 | P0 是阶段不是任务号，`锁定验收.json` 里没有 P0 条目；最近的是它之后的任务 X1、U6、V1 | **保留现状**：它本来就是「一个 config、`include` 两行、一步跑完」（`vitest.review-p0-f71da15-20260929.config.ts`），没有进程可省；第 1 轮我误写成「两个 config 各起一个进程、建议并成一步」，第 2 轮审查指出前后矛盾，已更正 |
| 17 | review-p1-action-loop | `review-p1-action-loop-20260916.test.ts`（4 项） | 目标驱动桌面办事闭环 + 真实产物独立断言 | P1 也是阶段；最近的锁定条目 T3「待办页」`apps/desktop/test/acceptance/t3-todos-ipc.test.ts`、D1「编码任务草案」 | 可以并进「P1-P3 阶段验收」：4 项一个进程不划算 |
| 18 | review-p1-memory-projects | `review-p1-memory-projects-20260916.test.ts`（7 项） | 自动分寸记忆 + 三个项目统筹 | A1、G02「项目简报尊重授权撤销」`…/g02-brief-authorization.test.ts` | 可以并进「P1-P3 阶段验收」：同上 |
| 19 | review-p1-research-skills | `review-p1-research-skills-20260916.test.ts`（5 项） | 主动研究去重 + 方法复用 | W1a「关注方向」`apps/desktop/test/acceptance/w1a-suggest-topics.test.ts`、G07 | 可以并进「P1-P3 阶段验收」：同上 |
| 20 | review-p2 | `review-p2-evolution-upgrade-20260916.test.ts`（5 项） | 受控实验 + 安全回滚 | A2（迁移前自动备份）、G05「准备阶段也能取消」`…/g05-cancel-preparing.test.ts` | 可以并进「P1-P3 阶段验收」：同上 |
| 21 | review-p3-connectors-lifecycle | `review-p3-connectors-lifecycle-20260916.test.ts`（6 项） | 连接器命名空间、知识边界、持久任务、目标搁置 | P3「项目进展简报」`…/p3-project-brief.test.ts`、T3 | 可以并进「P1-P3 阶段验收」：同上 |
| 22 | review-p3a-connector-registry | `review-p3a-connector-registry-20260916.test.ts`（6 项） | 注册表：幂等登记、游标单调、失败记录、撤销拦截、导入接线 | S1/S2「导入 Claude Code / Codex 会话」、S3a/S3b（导入类正例） | 可以并进「P1-P3 阶段验收」：同上 |
| 23 | review-direction-merged | `direction-quality-20260911.test.ts`（20 项）、`direction-recheck-20260914.test.ts`（12 项）、`direction-round2-93ecaed.test.ts`（12 项） | 方向质量 RQ01-RQ17（个人数据不上模型、授权工作区、越界写、exit-0、重复派发、取消、指纹、20s 超时）+ 复审 C01-C10 + 二轮 R01-R09（含用假 IPC 起 AppRuntime） | D7、V3、D2、M1「慢模型不再超时」、M3「换了 API 地址，旧 Key 不带到新地址」、N2、W2、X1（44 项横跨多件事，对应不到单条锁定测试） | 保留（内部可再并）：覆盖记忆/隐私/编码执行/研究预算四类高风险边界，别处没有；三份之间有重复（见下「同类重复」），合并成一份可以减少重复叙述，测试内容保留 |
| 24 | review-project-audit | `project-audit-20260906.test.ts`（15 项，A01-A15） | 全项目审核：重提炼不克隆、绑定、收件箱、冲突、提炼进行中、采集取消、简报预算、被拒建议、待复核 vs 已确认、证据段、引用、密钥存储 | X1「提炼打捞依据」、A2、N1「要求清单只在对上时提醒」、N2、T2a/T3、P3 | 可以并进「早期审核反例」：A01-A15 里多项在 14/25/26 里已有相邻反例（见下「同类重复」），合并不是删测试 |
| 25 | review-recheck | `recheck-20260907.test.ts`（11 项，RF01-RF08/B01-B10） | 复审反例：再提炼、纠正保护链、简报预算、密钥存储（safeStorage） | A2、M3、W2、X1 | 可以并进「早期审核反例」：同上 |
| 26 | review-recheck-round2 | `recheck-round2-20260907.test.ts`（10 项，F01-F03）、`f01-migration.test.ts`（1 项） | 二次复审对照 + 迁移 8→9 回填（`needs_review=1` 的旧库） | A2「迁移前自动备份」（锁定里唯一碰迁移的一条，测的是备份，不是回填；回填这条只此一份） | 可以并进「早期审核反例」：并的时候别丢 `f01-migration` |
| 27 | review-needs-lifecycle | `needs-lifecycle-20260908.test.ts`（5 项，N01） | 纠正退休前任原因、迁移器幂等（含 v8 满库对照） | A2；原因/要求相关的是 X1、N1、N2 | 可以并进「早期审核反例」：N01 与 26 的 F01 是同一族 |
| 28 | review-closure | `closure-b8f216b-20260908.test.ts`（5 项） | 迁移 10 命中范围、纠正回滚、重开库后原因保留、收件箱查询边界 | A2、N1、G01 | 可以并进「早期审核反例」：同上 |
| 29 | review-needs-lifecycle-ui | `needs-lifecycle-ui-20260908.spec.ts`、`playwright.needs-lifecycle-20260908.config.ts` | 生命周期界面（LUI01-LUI03），真 Electron | N1/N2 的界面锁定测试 `…/n1-requirements-page.test.ts`、`…/n2-finding-judgments-page.test.ts` | 可以并进「界面回归」：4 个界面步骤各起一个 Electron；合成一份 config（保持 `workers: 1`）少 3 次应用启动 |
| 30 | review-understanding-ui | `understanding-20260908.spec.ts`、`playwright.understanding-20260908.config.ts` | 理解页（UND01-UND02），真 Electron | X1 的界面部分在 core（`…/x1-salvage-excerpt.test.ts`）；理解页本身没有锁定界面测试 | 可以并进「界面回归」：同上 |
| 31 | review-sources-wizard-ui | `sources-20260908.spec.ts`、`wizard-20260908.spec.ts`、`playwright.sources-wizard-20260929.config.ts` | 来源页 SRC01-02 + 首次向导 WIZ01-02，真 Electron | P7「来源页加撤销读取」`…/p7-revoke-page.test.ts`、P5/P6/P8 的界面文件 | 可以并进「界面回归」：已经并过一次（sources + wizard 一份 config），同目录还留着 `playwright.sources-20260908.config.ts`、`playwright.wizard-20260908.config.ts` 两份老 config（门禁里不用），建议一起清 |
| 32 | review-recheck-ui | `recheck-ui-20260907.spec.ts`、`playwright.recheck-20260907.config.ts` | 复审界面 UI01 + BUI01 + BUI02，真 Electron | U1「研究页忙状态」`…/u1-research-busy.test.ts`、U2「任务页自己跟上状态」`…/u2-tasks-page-live.test.ts` | 可以并进「界面回归」：同上 |

### 「功能还在不在」怎么核对的（说清楚核到了哪一层）

`锁定验收.json` 只登记锁定测试，不登记功能。我核到的层次是**「源码还在、符号还导出、套件还跑得绿」**，**不是**「行为没被改过」——第 2 轮审查指出这一层不够证明功能仍在被用，这个批评成立，下面把能做到的和没做到的分开写：

做了的（都在 `C3a` 工作目录里跑过；脚本放 `.logs/`，不提交）：

- 30 个回归测试文件里的**相对源码引用全部 resolve 到现存的源文件**（0 处找不到；`.js` 后缀按 NodeNext 写法换回 `.ts` 再找）；
- 这些文件从 `@ixaeon/core` 引的符号（ItemService、PermissionService、Vault、Extractor、McpService、MIGRATIONS、currentMigrationVersion、saveConfig、sha256 等）**现在都还能在 `packages/core/src` 里找到导出**；
- 30 个文件对应的 23 个门禁步骤在这三次跑里**全是绿的**；
- **逐套把「被测的源码模块」列出来，并核了每个模块「生产代码里还被引用几次」「9 月以来改过几次提交」**（第 2 轮审查要求逐套，脚本 `.logs/audit-modules.mjs`）：

  | 套件 | 被测源码模块（生产代码引用次数 / 9 月以来改动提交数） |
  | --- | --- |
  | `continuity-round4`、`lifecycle-round3` | `apps/desktop/src/main/appRuntime.ts`（3/114）、`…/server/localServer.ts`（1/21） |
  | `direction-quality-20260911` | `packages/core/src/index.ts`（0/64，只看导出面）、`…/research/parse.ts`（2/2）、`…/research/fetchApproved.ts`（3/4） |
  | `direction-recheck-20260914` | `packages/core/src/index.ts`（0/64） |
  | `direction-round2-93ecaed` | `apps/desktop/src/main/ipc.ts`（2/67）、`appRuntime.ts`（3/114）、`packages/core/src/index.ts`（0/64）、`packages/core/src/access.ts`（12/9） |
  | `project-audit-20260906`、`recheck-20260907`、`v02-acceptance-20260906`、`review-20260905` | `appRuntime.ts`（3/114）、`ipc.ts`（2/67）等 |
  | `restructure-20260913` | `packages/core/src/memory/evalScenarios.ts`（1/5）、`index.ts`（0/64） |
  | `review-bbe651f-20260915` | `ipc.ts`（2/67）、`appRuntime.ts`（3/114）、`index.ts`（0/64） |
  | `review-p0-boundaries`、`review-f71da15` | `packages/contracts/src/index.ts`（0/1）、`packages/core/src/index.ts`（0/64）、`appRuntime.ts`（3/114）、`ipc.ts`（2/67）、`localServer.ts`（1/21） |
  | `review-p1-action-loop`、`review-p1-memory`、`review-p1-research`、`review-p2`、`review-p3-*` | 只 `from '@ixaeon/core'` 拿公开导出（0/64）+ 契约（0/1），不直接碰实现文件 |
  | 9 个界面/迁移/身份类套件（`*-ui`、`sources`、`wizard`、`f01-migration`、`identity-round3`、`needs-lifecycle`、`review-recheck-round2`、`closure-b8f216b`） | 没有相对源码引用（走 IPC/公开导出或纯界面），所以「模块还在不在」对它们不适用 |

- **删功能的提交只有一条**：`git log --diff-filter=D -- packages/core/src apps/desktop/src` 从 9 月起只有 `eba073f`（「删除 ModelPool/RoleCoordinator，Door 降级为设计稿」）。拿这三个名字搜 23 个回归套件，**一处都没提到**。

**没做的**（整合方要就得再排一单）：

- 第 2 轮审查说得对：`git log --diff-filter=D` 只看得见**文件级删除**，看不见「文件还在、里面的功能被删/被改」。上表的「引用次数/改动提交数」只能说明模块还在被引用、且这段时间一直在改，**不能证明某条套件测的行为没变**；
- 没有读每个套件的断言去比对当前行为，也没有追界面入口（某个 testid 是否还在渲染）。

### 「可以删」：这一单没有给出任何一条

规格要求「可以删」的每一条都写出能核对的依据（被哪个锁定测试文件的哪一条覆盖，或功能在哪次提交里删掉了）。逐条查下来**一条都不满足**，理由：

- 这 23 个回归步骤几乎全是**反例/边界**（「这个坏情况不该发生」），而锁定验收里多数是**功能正向验收**（「做了这个功能，行为应该这样」）。两者不是同一件事：把反例删掉，正向验收不会替它拦住回归。
  **更正（第 1、2 轮审查都指出）**：我原来写「锁定验收都是正例，所以没有覆盖关系」——**这个推论不成立**（AGENTS.md 自己就举了 W1a 的负向验收）。这一单**没有做断言级比对**；我做过的只有两条粗查：
  1. 上表每行「锁定验收里最近的一条」是按**主题**挑的最接近的用例（不是覆盖证明，列名已改成「按主题最接近的」）；
  2. 拿 678 条锁定验收用例的标题和 23 个套件的用例标题做 **2 字切片相似度**（中文没法按空格切词），阈值「共享 ≥6 个切片」时**只有 1 对候选**（`review-p1-memory-projects` × `a3-bridge-origin-tag.test.ts`，相似度 8，讲的是「用户采纳/系统推断」这类措辞，不是同一条断言）。
  所以准确的说法是：**「没有发现标题级的重复」，不等于「没有覆盖关系」**；「锁定验收里有没有某条负向用例正好接得住这套反例」确实没核，不能当「可以删」的依据。
- 唯一一类可能重叠的是「同一坏情况的相邻反例」——那些是**套件之间**重复，处理办法是并（上面已逐条写），不是删。
- 功能被删掉的套件：一个都没有（见上一节：唯一一条删功能的提交 `eba073f` 删的 ModelPool/RoleCoordinator/Door，23 个套件一处都没提到）。

要真删，得由整合方定方向（比如「只保留锁定验收 + unit/integration，回归全删」），我再按那个方向逐条给出「删掉之后哪条锁定测试/哪一种测试接得住」的对照表——那需要逐条读断言，这一单没做。

### 同类重复（合并时要注意的）

- **会话/来源连续性**：`review-round4`（U1-U7）与 `review-recheck`（B01-B06）、`review`（R1/R6/R8a/R8b）都在测「重开/刷新/再提炼不产生第二份来源或第二条分析」。
- **纠正与原因保留**：`review-needs-lifecycle`（L01/L02）、`review-closure`（C02-C04）、`review-v02`（V06）、`review-recheck-round2`（R2-03/R2-04）、`review-project-audit`（A04/A05）是同一族的相邻反例。
- **简报/预算**：`review-project-audit`（A07-A09）、`review-recheck`（B04）、`review-recheck-round2`（R2-06）、`review-p1-memory-projects` 有重叠。
- **密钥/证据存储**：`review-project-audit`（A15）、`review-recheck`（B08-B10）测同一件事。
- **迁移回填**：`review-recheck-round2`（`f01-migration`）与 `review-needs-lifecycle`（L04 对照）用同一批 v8 旧库夹具。
- **方向类三份**（`review-direction-merged` 内部）：`direction-quality` 的 RQ05/RQ06/RQ07/RQ08（授权工作区、越界写、exit-0 冒充、漏跑第二条命令）与 `direction-recheck` 的 C09/C10、`direction-round2` 的 R01-R03 讲的是同一批越界场景，措辞不同。

## 照这个分类做完，门禁剩几步、大约多久

先说清楚**步数**（第 2 轮审查指出我原来算错了，这里重算）：

| 方案 | 回归步骤 | 门禁总步数 | 说明 |
| --- | --- | --- | --- |
| 现在 | 23 | **32** | 9 个非回归 + 23 个回归 |
| **本单建议**（保留 4 步各自单列 + 3 个合并组） | 4 + 3 = **7** | **16** | 保留：`review-restructure`、`review-bbe651f`、`review-direction-merged`、`review-p0-f71da15`（它本来就是一步）；合并组：早期审核反例（9 套→1）、P1-P3 阶段验收（6 套→1）、界面回归（4 步 / 5 个 spec→1） |
| 再把「边界与方向」（`review-restructure` + `review-bbe651f`）并成一步 | 6 | **15** | 两套都在测授权/工具边界，可并 |
| 再把 P0 那一步并进「边界与方向」 | 5 | **14** | |
| 再把「界面回归」并进「边界与方向」 | 4 | **13** | 不推荐：界面套件要起 Electron，和纯逻辑混在一起失败时不好定位 |

（原来写的「12 步」是算错了——漏了 `review-bbe651f` 和 `review-p0-f71da15` 都还在分母里；按上表，**本单建议是 16 步**，再并两次才到 14 / 13。）

时间（都按三次的中位数，`114.9` 是非回归 9 步、`55.2` 是 19 个 vitest 回归步、`28.6` 是 4 个界面步；下面这些「套件耗时」**都已包含各自的进程启动开销**，所以合并时只减去省下来的那几次启动，别重复加）：

- 早期审核反例 9 套：合计 `26.2s`（已含 9 次启动）→ 并成 1 个后 `26.2 − 8×1.2 ≈ 16.6s`，省约 **9.6s**；
- P1-P3 6 套：合计 `13.5s`（已含 6 次启动）→ `13.5 − 5×1.2 ≈ 7.5s`，省约 **6.0s**；
- 界面 4 步：合计 `28.6s`（每个 spec 自己 `launch/close`，应用启动省不掉）→ 只省 3 次 runner 启动 ≈ **3.6s**（不是原来写的 6.0s）；
- `review-p0-f71da15`：本来就是一步，**不省**。

合计省约 **19.2s**：`198.7 → 约 179.5s`（**约 3 分 0 秒**）。两个假设（每个 vitest 进程启动 ≈1.2s、每次 playwright runner 启动 ≈1.2s）都是从只 2-4 项的套件仍要 2.0-2.6s 与 6.5-8.7s 反推的，**不是实测**——要精确，得先按上表并一组、再跑三次。

说白了：**降步数主要是让门禁读得懂（32 行 → 16 行），省时间很少（20 秒上下）**。锁定验收那一步（62.6s）和 integration（25.7s）才是时间大头，它们不在这一单的范围里。

### 每一组并进哪里（给整合方的落地清单）

先说清楚这个仓库的「测试项目」是什么：**每个回归套件各有自己的 config**（`apps/desktop/test/review/vitest.<套件>.config.ts`，里面只有一行 `include` 指向一个文件；界面套件是 `playwright.<套件>.config.ts`），`scripts/verify.mjs` 里一个 `run(...)` 对应一个这样的 config。所以「并进」的实际做法是：**留一个现有 config 当落点、把它的 `include` 扩成多文件，删掉同组其余 config，再把 verify.mjs 里对应的 `run(...)` 删掉**（第 2 轮审查要求写明并入哪个现有项目，这就是答案）。

| 合并组 | 落点（现有 config，改它的 `include`） | 删掉的 verify 步骤（`scripts/verify.mjs` 行号，按本单量时的版本） | 删掉的 config |
| --- | --- | --- | --- |
| 早期审核反例（9 步 / **11 个测试文件**） | `apps/desktop/test/review/vitest.config.ts`（现在是 `review-20260905.test.ts` 一个文件）→ `include` **再加 10 行**：`identity-round3.test.ts`、`lifecycle-round3.test.ts`（这两条现在是 `vitest.round3.config.ts` 的 `*round3.test.ts` 通配）、`continuity-round4.test.ts`、`v02-acceptance-20260906.test.ts`、`project-audit-20260906.test.ts`、`recheck-20260907.test.ts`、`recheck-round2-20260907.test.ts`、`f01-migration.test.ts`、`needs-lifecycle-20260908.test.ts`、`closure-b8f216b-20260908.test.ts` | 106 `review`（保留）、115 `review-round3`、124 `review-round4`、133 `review-v02`、235 `review-project-audit`、244 `review-recheck`、253 `review-recheck-round2`、262 `review-needs-lifecycle`、271 `review-closure` | `vitest.round3.config.ts`、`vitest.round4.config.ts`、`vitest.v02-review.config.ts`、`vitest.project-audit.config.ts`、`vitest.recheck-20260907.config.ts`、`vitest.recheck-round2-20260907.config.ts`、`vitest.needs-lifecycle-20260908.config.ts`、`vitest.closure-b8f216b-20260908.config.ts` |
| P1-P3 阶段验收（6 套） | `apps/desktop/test/review/vitest.review-p1-action-loop-20260916.config.ts` → `include` 加 5 行 | 172（保留）、181、190、199、208、217 | `vitest.review-p1-memory-projects-20260916.config.ts`、`vitest.review-p1-research-skills-20260916.config.ts`、`vitest.review-p2-evolution-upgrade-20260916.config.ts`、`vitest.review-p3-connectors-lifecycle-20260916.config.ts`、`vitest.review-p3a-connector-registry-20260916.config.ts` |
| 界面回归（4 步 / **5 个 spec**） | **保留一个 run**：`apps/desktop/test/review/playwright.sources-wizard-20260929.config.ts`（改 `testMatch` 到 5 个 spec），`scripts/verify.mjs` 里留 1 个 `run(...)` 跑它 | 只删 **3** 个：`review-needs-lifecycle-ui`、`review-understanding-ui`、`review-recheck-ui`（`review-sources-wizard-ui` 那个 run 留着并改 `testMatch`） | 不用删 config（`playwright.sources-wizard-20260929.config.ts` 留用；另外 3 个 `playwright.*.config.ts` 可删） |
| `review-p0-f71da15` | **不用并**：它本来就是「两个文件一个 config、一步跑完」（`vitest.review-p0-f71da15-20260929.config.ts` 的 `include` 是两行）。第 1 轮我写成「两个 config 各起一个进程」，第 2 轮审查发现前后矛盾，此处更正为**保留现状** | — | — |

界面的 4 步实际是 **5 个 spec**（`review-sources-wizard-ui` 那一步同时跑 `sources-20260908.spec.ts` 和 `wizard-20260908.spec.ts`，见 `playwright.sources-wizard-20260929.config.ts` 的 `testMatch`——第 2 轮审查提醒别漏，已按 5 个写）。合并后是不是能少 3 次应用启动，取决于每个 spec 是否各自 `launch`：4 个 `playwright.*.config.ts` 各自独立跑，spec 里自己 `launch/close`，所以**合并只省「playwright 进程与 runner 的启动」，不省应用启动**；上面时间估算里的「省 3×2s 应用启动」因此站不住，改成「省 3 次 runner 启动（约 3×1.2s ≈ 3.6s）」。

（行号是 `scripts/verify.mjs` 在本单量时的版本，合并前先 `git log -1 --oneline scripts/verify.mjs` 核一下有没有变。）

## 自动化通过

- 本单不改门禁，跑它是为了量：`node scripts/verify.mjs` 连跑三次全绿（exit 0），用时 259.9s / 195.6s / 197.5s，日志在操作目录 `.logs/verify-c3a-{1,2,3}.log`。**三次的步骤行原样贴在本节末尾**（第 2 轮审查要求贴原始输出，不再只给整理后的表）。
- 交付的只有这一份说明，没有源码改动：分支上 `git show --stat` 只有 `docs/委派/交付/C3a.md`。
- 在 `C3a` 工作目录里（这一分支的树）又跑了一遍 `node scripts/verify.mjs`：**全绿，exit 0**（末尾「全部通过（IXAEON v0.2 验证完成）」），说明加这份说明不影响门禁。
- GitHub 上的 verify：分支 `grok/C3a` 推上去之后跑过四次，同内容的三次绿、一次红——第一次（`e4d0f3d`，运行 39284824503）**绿**；第二次（`32605eb`，只多了一行文档，运行 39291200008）**红**，红的是 `apps/desktop/test/review/recheck-20260907.test.ts > B04 …` 报 `Error: Hook timed out in 10000ms`（慢 runner 上的钩子超时）；第三次（`cd0f5dd`，运行 39294416094）**绿**；第四次（`326e0a1`，运行 39296320651）**绿**。分支上只有 `docs/委派/交付/C3a.md` 一个文件，红的那次与本分支内容无关。这一条恰好是本单「套件本身有偶发」的实例，见下面已知缺口 6。本机在这一分支的树上跑 `node scripts/verify.mjs` 全绿（exit 0）。这份文档每改一次都会再触发一次 CI（内容只在文档里，结论同前）。

### 三次测量的原样输出（只看步骤行）

（来源：操作目录 `.logs/verify-c3a-{1,2,3}.log`，去掉 ANSI 颜色码后原样摘出；`build` 的三行子步骤也保留，它们的时间已包含在 `build` 那一步的 8.4s 里。）

第 1 次（36 行，原样）：

```
✓ lint（ESLint） 通过（6.4s）
✓ format:check（Prettier） 通过（3.5s）
✓ local-user（提交的文件里没有本机的账户名） 通过（0.3s）
✓ typecheck（tsc --noEmit） 通过（5.7s）
✓ desktop build（electron-vite） 完成（5.2s）
✓ mcp build（vite lib） 完成（2.5s）
✓ extension build（vite ×3 + 静态复制） 完成（0.6s）
✓ build（desktop / mcp / extension） 通过（8.4s）
✓ unit（Vitest 单元测试） 通过（5.1s）
✓ integration（Vitest 集成测试） 通过（65.2s）
✓ acceptance-lock（锁定的验收测试没被改） 通过（0.1s）
✓ acceptance（已完成任务的锁定验收测试） 通过（70.9s）
✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） 通过（3.2s）
✓ review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） 通过（4.5s）
✓ review-round4（四次验收连续性 7 项，修复 F1-F4 回归） 通过（3.1s）
✓ review-v02（v0.2 验收 15 项，修复 G1-G8 回归） 通过（3.2s）
✓ review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） 通过（3.9s）
✓ review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） 通过（3.2s）
✓ review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） 通过（4.6s）
✓ review-p1-action-loop（P1-A 目标驱动桌面办事闭环与真实产物独立断言 4 项） 通过（3.1s）
✓ review-p1-memory-projects（P1-B 自动分寸记忆与 P1-C 三个项目统筹 7 项） 通过（2.5s）
✓ review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） 通过（3.0s）
✓ review-p2（P2 受控实验与安全回滚 5 项） 通过（2.6s）
✓ review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） 通过（3.1s）
✓ review-p3a-connector-registry（P3-A 连接器注册表：游标/覆盖/失败/撤销/导入接线 6 项） 通过（2.3s）
✓ review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） 通过（6.1s）
✓ review-project-audit（全项目审核 15 项，修复 C01-C13 回归） 通过（3.3s）
✓ review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） 通过（3.8s）
✓ review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） 通过（3.5s）
✓ review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） 通过（2.3s）
✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） 通过（2.3s）
✓ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） 通过（8.7s）
✓ review-understanding-ui（理解页 UND01-UND02，真实 Electron） 通过（6.5s）
✓ review-sources-wizard-ui（来源页 SRC01-02 + 向导 WIZ01-02，真实 Electron） 通过（7.8s）
✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） 通过（7.7s）
全部通过（IXAEON v0.2 验证完成）
```

第 2 次（36 行，原样）：

```
✓ lint（ESLint） 通过（6.2s）
✓ format:check（Prettier） 通过（3.3s）
✓ local-user（提交的文件里没有本机的账户名） 通过（0.3s）
✓ typecheck（tsc --noEmit） 通过（5.3s）
✓ desktop build（electron-vite） 完成（4.7s）
✓ mcp build（vite lib） 完成（2.3s）
✓ extension build（vite ×3 + 静态复制） 完成（0.5s）
✓ build（desktop / mcp / extension） 通过（7.5s）
✓ unit（Vitest 单元测试） 通过（3.6s）
✓ integration（Vitest 集成测试） 通过（25.7s）
✓ acceptance-lock（锁定的验收测试没被改） 通过（0.1s）
✓ acceptance（已完成任务的锁定验收测试） 通过（62.6s）
✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） 通过（2.8s）
✓ review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） 通过（4.0s）
✓ review-round4（四次验收连续性 7 项，修复 F1-F4 回归） 通过（2.5s）
✓ review-v02（v0.2 验收 15 项，修复 G1-G8 回归） 通过（2.8s）
✓ review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） 通过（3.4s）
✓ review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） 通过（2.9s）
✓ review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） 通过（3.9s）
✓ review-p1-action-loop（P1-A 目标驱动桌面办事闭环与真实产物独立断言 4 项） 通过（2.6s）
✓ review-p1-memory-projects（P1-B 自动分寸记忆与 P1-C 三个项目统筹 7 项） 通过（2.1s）
✓ review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） 通过（2.4s）
✓ review-p2（P2 受控实验与安全回滚 5 项） 通过（2.0s）
✓ review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） 通过（2.0s）
✓ review-p3a-connector-registry（P3-A 连接器注册表：游标/覆盖/失败/撤销/导入接线 6 项） 通过（2.0s）
✓ review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） 通过（5.1s）
✓ review-project-audit（全项目审核 15 项，修复 C01-C13 回归） 通过（2.7s）
✓ review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） 通过（3.2s）
✓ review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） 通过（2.7s）
✓ review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） 通过（2.0s）
✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） 通过（2.0s）
✓ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） 通过（7.2s）
✓ review-understanding-ui（理解页 UND01-UND02，真实 Electron） 通过（6.0s）
✓ review-sources-wizard-ui（来源页 SRC01-02 + 向导 WIZ01-02，真实 Electron） 通过（7.4s）
✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） 通过（7.3s）
全部通过（IXAEON v0.2 验证完成）
```

第 3 次（36 行，原样）：

```
✓ lint（ESLint） 通过（6.1s）
✓ format:check（Prettier） 通过（3.1s）
✓ local-user（提交的文件里没有本机的账户名） 通过（0.2s）
✓ typecheck（tsc --noEmit） 通过（5.1s）
✓ desktop build（electron-vite） 完成（4.8s）
✓ mcp build（vite lib） 完成（2.3s）
✓ extension build（vite ×3 + 静态复制） 完成（0.5s）
✓ build（desktop / mcp / extension） 通过（7.7s）
✓ unit（Vitest 单元测试） 通过（3.7s）
✓ integration（Vitest 集成测试） 通过（25.6s）
✓ acceptance-lock（锁定的验收测试没被改） 通过（0.1s）
✓ acceptance（已完成任务的锁定验收测试） 通过（62.6s）
✓ review（二次验收独立业务测试 11 项，修复 R1-R9 回归） 通过（3.0s）
✓ review-round3（三次验收相邻场景 13 项，修复 N1-N6 回归） 通过（4.0s）
✓ review-round4（四次验收连续性 7 项，修复 F1-F4 回归） 通过（2.6s）
✓ review-v02（v0.2 验收 15 项，修复 G1-G8 回归） 通过（2.7s）
✓ review-restructure（重整审核 15 项，修复 A01-A05/A07/A08/A09 第一批回归） 通过（3.4s）
✓ review-bbe651f（M0 可信边界 14 项，修复 Q01-Q07 回归） 通过（2.8s）
✓ review-p0-f71da15（P0 可信基础与 M0/M1 边界预算合并套件 19 项） 通过（3.8s）
✓ review-p1-action-loop（P1-A 目标驱动桌面办事闭环与真实产物独立断言 4 项） 通过（2.5s）
✓ review-p1-memory-projects（P1-B 自动分寸记忆与 P1-C 三个项目统筹 7 项） 通过（2.0s）
✓ review-p1-research-skills（P1-D 主动研究去重与 P1-E 方法复用 5 项） 通过（2.6s）
✓ review-p2（P2 受控实验与安全回滚 5 项） 通过（2.1s）
✓ review-p3-connectors-lifecycle（P3 连接器命名空间、知识边界、持久任务与目标搁置 6 项） 通过（2.0s）
✓ review-p3a-connector-registry（P3-A 连接器注册表：游标/覆盖/失败/撤销/导入接线 6 项） 通过（2.1s）
✓ review-direction-merged（方向质量/复审/二轮复审合并套件 44 项） 通过（5.3s）
✓ review-project-audit（全项目审核 15 项，修复 C01-C13 回归） 通过（2.8s）
✓ review-recheck（v0.2 复审 11 项，修复 RF01-RF08 回归） 通过（3.6s）
✓ review-recheck-round2（二次复审 10 项，修复 F01-F03 回归） 通过（3.1s）
✓ review-needs-lifecycle（三次复审核心 5 项，修复 N01 回归） 通过（2.1s）
✓ review-closure（修复收尾验收 5 项：迁移命中范围/回滚/重开库/原因保留/查询边界） 通过（2.2s）
✓ review-needs-lifecycle-ui（三次复审界面 LUI01-LUI03，真实 Electron） 通过（7.6s）
✓ review-understanding-ui（理解页 UND01-UND02，真实 Electron） 通过（6.2s）
✓ review-sources-wizard-ui（来源页 SRC01-02 + 向导 WIZ01-02，真实 Electron） 通过（7.5s）
✓ review-recheck-ui（复审界面 UI01 + BUI01 + BUI02，真实 Electron） 通过（7.3s）
全部通过（IXAEON v0.2 验证完成）
```

## 真机通过

不适用：本单不改源码、不改测试、不改门禁，没有要跑的界面检查。

## Codex 审查（A 档）

**第 1 轮（2026-10-20 09:16 左右，额度恢复后）：需要修改（exit 1）**，6 条必须改。原样意见在 [`C3a-Codex审查.md`](C3a-Codex审查.md)，逐条处理：

| # | Codex 说的 | 怎么处理的（含第 2 轮后的更正） |
| --- | --- | --- |
| 1 | 预计步数漏了明确「保留」的 `review-bbe651f`；按所列分组应是 15 步，两次合并也只能到 13 步，不能报 12 步 | **照改**：重算步数表：现状 32 → **本单建议 16**（保留 4 步 + 3 个合并组）→ 再并「边界与方向」15 → 再并 P0 14 → 再并界面 13 |
| 2 | 用「锁定验收都是正例」推「没有覆盖关系」不成立（AGENTS.md 自己提到 W1a 的负向验收） | **照改（更正结论）**：没有做断言级比对；只做了「按主题挑最接近」+ 678 条锁定用例标题的 **2 字切片相似度**粗查（阈值 ≥6 时只有 1 对候选），并明确「没有发现标题级重复 ≠ 没有覆盖关系」 |
| 3 | 源码引用在、符号还导出、测试绿，不能证明功能还在用、也不能排除行为被改 | **照改（分层写 + 逐套列表）**：「功能还在不在」一节现在写明核到哪一层，并**逐套列出被测源码模块 + 生产引用次数 + 9 月以来改动提交数**（`.logs/audit-modules.mjs` 产出）；同时写清 `--diff-filter=D` 只看得到文件级删除，看不到文件内删功能/改行为 |
| 4 | 「早期审核反例」「P1-P3 阶段验收」只有组名，没说并入哪 | **照改（第 2 轮再改）**：说明「测试项目」在这个仓库就是**每个套件一个 config**，落地＝**改某个现有 config 的 `include` + 删同组其余 config + 删 verify.mjs 对应 `run(...)`**，并逐组给出落点 config、要删的 verify 行号、要删的 config 名 |
| 5 | `local-user` 在 CI 上不检查，标成「跑」会误报 | **照改**：第 3 行改成「跑（CI 上等于不查）」，上面那句也改成「每一步都会被执行，但 `local-user` 在 CI 上查不出东西」 |
| 6 | 三次测量只给了整理后的表和日志路径，没贴原始输出 | **照改**：「自动化通过」末尾新增「三次测量的原样输出」（36 行 × 3 原样贴入） |

**第 2 轮（2026-10-20 09:44 左右）：需要修改（exit 1）**，又是 6 条必须改。逐条处理：

| # | Codex 说的 | 怎么处理的 |
| --- | --- | --- |
| 1 | 未比对断言，只看标题/用例名；第 69 行「没有覆盖关系」缺依据 | **照改**：删掉「没有覆盖关系」的断言，改成两条粗查的实际结果 + 明确写「没有断言级比对，给不出覆盖证明」；列名改成「按主题最接近的锁定验收用例（不是覆盖证明）」 |
| 2 | 把功能现状推给别的任务；`--diff-filter=D` 排不掉「文件内删功能/改行为/移除入口」 | **照改**：补了逐套的模块存活表（生产引用次数 / 改动提交数），并把「看不到文件内改动」写成明确的局限，不再说「不能排除」以外的结论 |
| 3 | 只给拟新建的测试组和 config，没指出并入哪个**现有**测试项目 | **照改**：落地清单改成「落点＝现有 config + 改它的 `include`」，逐个列出落点 config 与要删的 config |
| 4 | P0「两个 config 各起一个进程」与后文「已经是两个文件共用一个进程」矛盾 | **照改**：查了 `vitest.review-p0-f71da15-20260929.config.ts` —— 它本来就是**一个 config、`include` 两行、一步跑完**，分类改成「保留现状」，并注明第 1 轮写错了 |
| 5 | 26.2s / 13.5s 已含启动开销，再加一遍是重复计算；应为 16.6s / 7.5s | **照改**：按 `26.2 − 8×1.2 ≈ 16.6s`、`13.5 − 5×1.2 ≈ 7.5s` 重算；界面那组也改成「只省 3 次 runner 启动 ≈3.6s（每个 spec 自己 launch/close，应用启动省不掉）」，总节省 19.2s、总时长约 **179.5s** |
| 6 | 4 个界面步骤实际是 5 个 spec，落地清单只写 4 个，有漏测风险 | **照改**：改成「4 步 / 5 个 spec」，并写明 `review-sources-wizard-ui` 那一步同时跑 `sources-20260908.spec.ts` 与 `wizard-20260908.spec.ts`（看 `playwright.sources-wizard-20260929.config.ts` 的 `testMatch`） |

**第 3 轮（2026-10-20 09:52 左右）：需要修改（exit 1）**，3 条。两条照改，一条不同意（按 AGENTS.md「第三轮还是需要修改就停下、改「待复审（整合方）」」处理）：

| # | Codex 说的 | 怎么处理的 |
| --- | --- | --- |
| 1 | 早期审核反例 9 步实际含 **11 个测试文件**，`include` 应加 10 行而不是 8 行 | **照改**：查了 9 个 config 的 `include`（`vitest.round3.config.ts` 是 `*round3.test.ts` 通配 → 两个文件；`vitest.recheck-round2-20260907.config.ts` 是两行），落地清单已列出 **11 个文件全名**、写明「保留 1 个 + 再加 10 行」 |
| 2 | 界面那 4 个 `run(...)` 全列为删除，没写保留哪个，按清单做会让界面套件退出门禁 | **照改**：改成「保留 1 个 run（`playwright.sources-wizard-20260929.config.ts` 扩到 5 个 spec）」，只删 3 个 `run(...)` |
| 3（合并两条） | 仍未做断言级覆盖比对 / 功能现状逐套核对，要求「逐套核对候选锁定测试、写明文件用例与覆盖情况」「核对被测行为的当前实现及相关变更，对已删/改掉的功能列出提交」 | **不同意（按 AGENTS.md 转整合方）**：这两条要求等于把这一单（量 + 分）扩成一次行为级审计。理由是：<br>① 这一单的交付物是「量出来的数 + 分类 + 可核对的理由」，规格第 3 步的「覆盖」判断我按主题给了最接近的条目，并**明确写了「这是线索不是覆盖证明」**——硬要出覆盖证明，得逐条读 678 条锁定用例的断言与 23 个套件的断言比对，工作量比这一单本身大一个量级；<br>② 「功能现状」这一条同理：要证明「行为没被改」得逐套追调用链和断言，不是 `git log` 能做到的；我已经把能做到的（模块存活、生产引用、改动提交数、唯一一次删功能的提交）逐套列了，并把做不到的写清楚；<br>③ 按 AGENTS.md，第 3 轮仍「需要修改」就停下交整合方定方向——整合方要行为级审计，这是新的一单（我在已知缺口里写了建议的单子范围）。 |

三轮意见、原样输出都在 [`C3a-Codex审查.md`](C3a-Codex审查.md)。按 AGENTS.md，**分支不合并，队列这一行改「待复审（整合方）」**。

```text
Codex 额度用完：分支先等着，队列状态改「待审（Codex 额度）」，稍后重跑。
ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 25th, 2026 10:54 AM.
```

## 已知缺口

1. 规格里的两个数已经过时（35 步 → 实际 32 步；27 套 → 实际 23 套；十来分钟 → 本机 3 分 19 秒）。这一单按现状量，没有去改规格。**整合方是否需要顺手改规格里的数，这一单没做。**
2. 「可以删」这一单没给出任何一条（理由见上）。如果整合方的意思是「回归整体不要了」，需要再给一条方向，我再出对照表——现在的分类只到「并」。
3. 每步用时的本机抖动很大（第一次 integration 65.2s，后两次 25.6s；第一次 acceptance 70.9s，后两次 62.6s）。中位数只能当参考；CI 上的数会比本机高（少了缓存、runner 慢）。
4. 界面 4 步并成 1 步后，失败时只能从 vitest/playwright 报告定位是哪一个 spec，比现在一步一个 spec 难一点；`workers: 1` 必须保持。
5. 这一单没量「并起来之后实际差多少」——上面的 179.5s 是按「vitest 进程启动 ≈1.2s/个、playwright runner 启动 ≈1.2s/次」估的（从只 2-4 项的套件仍要 2.0-2.6s、6.5-8.7s 反推），**不是实测**。整合方要精确数，得先按「每一组并进哪里」那张表真并一组、再跑三次。
6. **回归套件有偶发（这一单亲眼见到一次，但不是本次量的 3 遍里）**：`grok/C3a` 第二次推上去时，CI 上 `review-recheck`（本机 6.9s / 4.0s）里 `B04: near-budget responses must include truncation notice and chars_used digits without overflow` 报 `Error: Hook timed out in 10000ms`（该文件跑了 112.3s，vitest 的 10s 钩子上限被慢 runner 撞上），而同一份内容上一次 CI 是绿的、本机连跑 3 遍也全绿。意思：**「可并」的套件里有偶发红，并在一切之前要先把这类钩子超时治掉**（例如给这一条加单测级超时或把重活挪进测试体），否则并成一步之后一次偶发会带走一整步。这一单只量没改，改法留给整合方定。
7. **两件「这一单没做、也不该在这一单做」的事**（第 3 轮 Codex 要求的两条，我按「不同意」转给整合方）：
   - **断言级覆盖比对**：把 678 条锁定验收用例的断言与 23 个套件的断言逐对比对，判断有没有哪条反例被某条锁定负向用例接住。这一单只做了主题/标题级的粗查（结果见「可以删」一节）。要真做，建议单开一单（规模：先挑 3-5 个最可疑的套件做试点，每个约半天）。
   - **逐套功能现状核查**：核对每个套件测的行为在当前实现里是否还被用到、有没有被改掉。这一单给了模块存活表（生产引用次数 / 9 月以来改动提交数）+ 唯一一次删功能的提交（`eba073f`），但**没有**读断言、没有追界面入口。同样建议单开一单，或者整合方在复审时按可疑度抽查。

## 用户接受

未发生（用户用过并认可之后才写）。
## 整合方复审（2026-10-20）

结论：并入（只有这份分析）。A 档，Codex 审了三轮，第 3 轮两条开发 agent 明确「不同意」，转过来的。

分析扎实、也诚实：门禁现在 32 步、中位约 3 分 19 秒（不是规格里写的「十来分钟」）；照方案合并只省约 19 秒，可删 0 条；它把自己推论里不成立的地方也照实更正了。

整合方定：

- **门禁瘦身到此为止，C3 不再往下做。** 合并省 19 秒、删不掉任何一条，降步数只是让门禁读起来短一点，不值得冒「并的时候漏掉一条反例」的险。时间大头在锁定验收（约 63 秒）和集成测试（约 26 秒），那是另一回事，等真成了瓶颈再说。
- 第 3 轮那两条（断言级覆盖比对、逐套功能现状核查）**不做**——它们是「要删」时才需要的功课，既然不删，就不用做。
- 已知缺口 6 的「钩子超时」：整合方已经修了（回归套件配置补上和单条测试一样长的 `hookTimeout`，写明「不放宽超时」的两份没动）。
