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

CI（`.github/workflows/verify.yml`）只有一个「门禁（与本机 node scripts/verify.mjs 相同）」步骤直接跑 `node scripts/verify.mjs`，所以**下面每一步都在 CI 上跑**（外加一步 `node scripts/test-e2e.mjs desktop`）。「CI 跑不跑」一列因此全填「跑」。

| # | 步骤（门禁打印的名字） | 做什么 | 三次用时（s） | 中位数（s） | CI 跑不跑 |
| --- | --- | --- | --- | --- | --- |
| 1 | lint（ESLint） | 全仓 ESLint | 6.4 / 6.2 / 6.1 | 6.2 | 跑 |
| 2 | format:check（Prettier） | 检查格式（`apps/*/src`、`packages/*/src`、`scripts/**/*.mjs`、根 `*.{ts,mjs,json}`） | 3.5 / 3.3 / 3.1 | 3.3 | 跑 |
| 3 | local-user（提交的文件里没有本机的账户名） | 查跟踪的文件里有没有本机账户名（只在开发机拦得住） | 0.3 / 0.3 / 0.2 | 0.3 | 跑 |
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

「锁定验收里最近的一条」这一列是照规格第 3 步查的：`docs/委派/锁定验收.json` 里 52 个已完成任务、每条登记了锁定测试文件，逐个套件去找**管得最近的那一条**。查到的情况一句话：**没有一条是「覆盖」关系**——锁定的都是「这个功能该有的行为」（正例），这 23 步里绝大多数是「这个坏情况不该发生」（反例），所以下面每行写的是「最近的一条」，不是「同一条」。

| # | 门禁步骤 | 测试文件（`apps/desktop/test/review/`） | 测了什么（一句话） | 锁定验收里最近的一条 | 分类与理由 |
| --- | --- | --- | --- | --- | --- |
| 10 | review | `review-20260905.test.ts`（11 项，R1-R8b） | 恢复/回滚的原子性：恢复失败不重建、回滚不丢待分析、撤销期间不提炼、证据引用不泄漏、角色保留、尾随自动分析、对话合并 | R1「恢复失败后重建聊天」`apps/desktop/test/acceptance/r1-rebuild-conversations-semantic.test.ts`、G01「会话重建后补历史」`packages/core/test/acceptance/g01-session-rebuild.test.ts`（都是正例：重建该怎么做；这套管的是「失败时不许重建、回滚不许丢东西」） | 可以并进「早期审核反例」：与 11/12/13/24/25/26/27/28 同一批服务（ItemService/PermissionService/Vault/SourceStore）的相邻反例，一次 vitest 启动就能全跑 |
| 11 | review-round3 | `identity-round3.test.ts`（2 项）、`lifecycle-round3.test.ts`（11 项，N1-N6） | 草稿/正式会话身份不被混同；暂停/恢复/回滚/8000 字拆分 | G01、G06「对话的项目固定」`apps/desktop/test/acceptance/g06-conversation-project.test.ts` | 可以并进「早期审核反例」：同上；`identity-round3` 只有 2 项，单独一个进程不划算 |
| 12 | review-round4 | `continuity-round4.test.ts`（7 项，F1-F4） | 刷新/重开/切草稿的连续性、关掉 autoAnalyze 后排队提炼不再调模型（含对照） | G06、A4「切回来接着看还在写的回答」`apps/desktop/test/acceptance/a4-follow-live.test.ts`、R1 | 可以并进「早期审核反例」：同上 |
| 13 | review-v02 | `v02-acceptance-20260906.test.ts`（15 项，G1-G8） | 队列取消、孤儿任务、内容修订号、v1 库升级不得标成已分析、纠正不得复活、矛盾不得被丢、来源移动/换项目、待复核、幂等键跨项目 | A1「分析失败耐心重试」`packages/core/test/acceptance/a1-patient-retry.test.ts`、A2「迁移前自动备份」`…/a2-backup-before-migrate.test.ts`、X1、N2 | 可以并进「早期审核反例」：同上 |
| 14 | review-restructure | `restructure-20260913.test.ts`（15 项，A01-A05/A07-A09） | 工具边界 H01-H05（越界写、exit-0 冒充验证、漏跑第二条命令）、记忆边界 M01/M03、验证范围 E01-E03 | D7「只发批准范围内的文件、只改批准范围内的」`packages/core/test/acceptance/d7-model-executor.test.ts`、V3「零依赖档跑的程序连不出去」`…/v3-verify-no-network.test.ts`、D2「独立验证按档位进沙箱」`…/d2-*.test.ts`（正例都在；「越界写能不能得逞」「exit-0 能不能冒充验证」只有这套和 23 在管） | 保留（并进「边界与方向」也可以）：这套管**授权边界**，别处没有等价反例 |
| 15 | review-bbe651f | `review-bbe651f-20260915.test.ts`（14 项，Q01-Q07） | 搜索/TinyFish 契约、技能证据门槛、看门狗、分数与来源 | G07「搜索预算按天恢复」`…/g07-daily-budget.test.ts` 等 3 份、W1a「关注方向」、P3「项目进展简报」 | 保留：外部契约类反例，锁定里没有对应条目 |
| 16 | review-p0-f71da15 | `review-p0-boundaries-20260916.test.ts`（12 项）、`review-f71da15-20260916.test.ts`（7 项） | P0 可信基础边界 + MCP/搜索权限 + F02-F06 | P0 是阶段不是任务号，`锁定验收.json` 里没有 P0 条目；最近的是它之后的任务 X1、U6、V1 | 可以并进（两文件并成一步）：两个 config 各起一个 vitest 进程，两文件测同一批边界 |
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

### 「功能还在不在」怎么核对的

`锁定验收.json` 只登记锁定测试，不登记功能；**「功能被哪次提交删了」这次一条都没有**。核对办法（都在 `C3a` 工作目录里跑过；脚本放在 `.logs/check-sources.mjs`，不提交）：

- 30 个回归测试文件里的**相对源码引用全部 resolve 到现存的源文件**（0 处找不到；`.js` 后缀按 NodeNext 写法换回 `.ts` 再找）；
- 这些文件从 `@ixaeon/core` 引的符号（ItemService、PermissionService、Vault、Extractor、McpService、MIGRATIONS、currentMigrationVersion、saveConfig、sha256 等）**现在都还能在 `packages/core/src` 里找到导出**；
- 30 个文件对应的 23 个门禁步骤在这三次跑里**全是绿的**——跑得起来本身就是「功能还在」最硬的证据。

没有逐套去 `git log` 翻「删除提交」：上面两条已经排除了「源码被删」，再翻历史只是在核实过程；整合方要查可以照 `git log --oneline -- apps/desktop/src/main/appRuntime.ts` 这类命令自己看。

### 「可以删」：这一单没有给出任何一条

规格要求「可以删」的每一条都写出能核对的依据（被哪个锁定测试文件的哪一条覆盖，或功能在哪次提交里删掉了）。逐条查下来**一条都不满足**，理由：

- `docs/委派/锁定验收.json` 里 52 个任务的锁定测试都是**功能正向验收**（「做了这个功能，行为应该这样」），而这 23 个回归步骤几乎全是**反例/边界**（「这个坏情况不该发生」）。两者不是同一件事：把反例删掉，正向验收测试不会替它拦住回归。所以我不能写「被 A1/a1-patient-retry.test.ts 覆盖」这种话——那是把正向验收当反例的替代品。
- 唯一一类可能重叠的是「同一坏情况的相邻反例」——那些是**套件之间**重复，处理办法是并（上面已逐条写），不是删。
- 功能被删掉的套件：一个都没有（见上一节的三条核对）。

要真删，得由整合方定方向（比如「只保留锁定验收 + unit/integration，回归全删」），我再按那个方向逐条给出「删掉之后哪条锁定测试/哪一种测试接得住」的对照表。

### 同类重复（合并时要注意的）

- **会话/来源连续性**：`review-round4`（U1-U7）与 `review-recheck`（B01-B06）、`review`（R1/R6/R8a/R8b）都在测「重开/刷新/再提炼不产生第二份来源或第二条分析」。
- **纠正与原因保留**：`review-needs-lifecycle`（L01/L02）、`review-closure`（C02-C04）、`review-v02`（V06）、`review-recheck-round2`（R2-03/R2-04）、`review-project-audit`（A04/A05）是同一族的相邻反例。
- **简报/预算**：`review-project-audit`（A07-A09）、`review-recheck`（B04）、`review-recheck-round2`（R2-06）、`review-p1-memory-projects` 有重叠。
- **密钥/证据存储**：`review-project-audit`（A15）、`review-recheck`（B08-B10）测同一件事。
- **迁移回填**：`review-recheck-round2`（`f01-migration`）与 `review-needs-lifecycle`（L04 对照）用同一批 v8 旧库夹具。
- **方向类三份**（`review-direction-merged` 内部）：`direction-quality` 的 RQ05/RQ06/RQ07/RQ08（授权工作区、越界写、exit-0 冒充、漏跑第二条命令）与 `direction-recheck` 的 C09/C10、`direction-round2` 的 R01-R03 讲的是同一批越界场景，措辞不同。

## 照这个分类做完，门禁剩几步、大约多久

按上面的「可以并进」做完（**内容一条不删**）：

| 现在 | 并之后 | 说明 |
| --- | --- | --- |
| 32 步 / 198.7s | **12 步 / 约 2 分 54 秒** | 19 个 vitest 步骤并成 3 个（早期审核反例 9 套→1、边界与方向 2 套→1、P1-P3 阶段验收 6 套→1，另外 `review-p0-f71da15` 两份文件并成 1 步）、4 个界面步骤并成 1 个 |

- 步骤：9（非回归）+ 2（边界与方向、P1-P3）+ 1（早期审核反例）+ 1（P0 两文件并一步）+ 1（界面回归）= **14 步**；再把「P0 两文件并一步」并进「边界与方向」是 **13 步**；再把「界面回归」并进「边界与方向」是 **12 步**（不推荐：界面套件要起 Electron，和纯逻辑套件混在一起失败时不好定位）。
- 时间：现在 19 个 vitest 步骤的 55.2s 里，大约有 **19×1.2s ≈ 23s 是每个进程的固定开销**；并成 3 个后约 36s。4 个界面步骤 28.6s 里约 3×2s 是应用启动开销，并成 1 个后约 23s。所以总时间约 `114.9 + 36 + 23 ≈ 174s`（**约 2 分 54 秒**，比现在少约 25 秒）。
- 说白了：**降步数主要是让门禁读得懂（32 行 → 12 行），省时间很少（25 秒上下）**。锁定验收那一步（62.6s）和 integration（25.7s）才是时间大头，它们不在这一单的范围里。

## 自动化通过

- 本单不改门禁，跑它是为了量：`node scripts/verify.mjs` 连跑三次全绿（exit 0），用时 259.9s / 195.6s / 197.5s，日志在操作目录 `.logs/verify-c3a-{1,2,3}.log`。
- 交付的只有这一份说明，没有源码改动：`git diff --stat` 里只有 `docs/委派/交付/C3a.md`。
- GitHub 上的 verify：推送后看（本单只加文档，跑的是同一套门禁）。

## 真机通过

不适用：本单不改源码、不改测试、不改门禁，没有要跑的界面检查。

## Codex 审查（A 档）

结论：待跑（`node scripts/codex-review.mjs C3a`）。

## 已知缺口

1. 规格里的两个数已经过时（35 步 → 实际 32 步；27 套 → 实际 23 套；十来分钟 → 本机 3 分 19 秒）。这一单按现状量，没有去改规格。**整合方是否需要顺手改规格里的数，这一单没做。**
2. 「可以删」这一单没给出任何一条（理由见上）。如果整合方的意思是「回归整体不要了」，需要再给一条方向，我再出对照表——现在的分类只到「并」。
3. 每步用时的本机抖动很大（第一次 integration 65.2s，后两次 25.6s；第一次 acceptance 70.9s，后两次 62.6s）。中位数只能当参考；CI 上的数会比本机高（少了缓存、runner 慢）。
4. 界面 4 步并成 1 步后，失败时只能从 vitest/playwright 报告定位是哪一个 spec，比现在一步一个 spec 难一点；`workers: 1` 必须保持。
5. 这一单没量「并起来之后实际差多少」——上面的 174s 是按「进程启动开销 ≈1.2s/个、应用启动 ≈2s/个」估的（这两个数是从 `review-*` 步骤里只有 2-4 项的套件仍要 2.0-2.6s 反推的）。整合方要精确数，得先真的并一套量一次。

## 用户接受

未发生（用户用过并认可之后才写）。