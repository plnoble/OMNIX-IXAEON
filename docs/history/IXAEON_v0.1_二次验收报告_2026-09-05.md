# IXAEON v0.1 二次验收报告

审核日期：2026-09-05。

审核对象：提交 `235a621d7c5d2d0a66a9595b343f0cbfe21e1624`，以及本次交付的 Windows 打包产物。

## 结论：暂不通过验收

这轮有实质进展：常规检查和端到端测试通过，打包版 MCP 也确实可以脱离源码、使用自带运行时完成读写。

但“测试全部通过”不能替代功能验收。此次针对代码中发现的缺口补了 11 项独立测试，11 项都因业务断言不满足而失败，归为下方 R1–R8 八组问题；另在打包版界面复现 R9。它们不是整个产品的随机抽样通过率，而是针对具体疑点的复现证据。

最重要的问题是：**恢复不通且失败回滚不安全；撤销授权不完整；自动分析可能漏掉后续内容；不同对话可能被合并；提取结果的依据和说话人信息不可靠。**

建议先修这些问题，不把 Door、设备能力检测或分布式执行加入这轮开发。

本次仅增加审核报告、独立测试和测试结果，未修改生产代码，未使用真实用户数据库、密钥或收费模型。

## 一、验证范围与结果

| 检查                                     | 本次结果     | 边界说明                                                                 |
| ---------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `corepack pnpm verify`                   | 通过         | lint、格式、类型、16 项单元测试、97 项集成测试与构建                     |
| `corepack pnpm test:e2e`                 | 通过         | 桌面 10 项；扩展配对、采集、流式内容、暂停与恢复等场景                   |
| 新增独立业务测试                         | 11 项失败    | 均成功运行后在预期业务行为处失败，不是测试框架启动失败                   |
| 仓库外的 `win-unpacked` 产物             | MCP 通过     | 复制到新建临时目录；读取产物生成的配置；STDIO 握手和四个工具真实调用     |
| 不依赖全局 Node.js                       | 本机实测通过 | MCP 使用产物的 `IXAEON.exe`；子进程 PATH 仅保留 Windows System32         |
| 自定义目录后端保存、完整退出重启         | 通过         | 无 `IXAEON_DATA_DIR` 覆盖；通过公开 IPC 设置；重启后目录、设置与项目保留 |
| 自定义目录界面                           | 不通过       | 正常启动时勾选框也禁用，不能按界面流程选择目录                           |
| 真实模型的六组问答                       | 未验证       | 没有调用真实模型；不能把 FakeProvider 或检索命中当作语义质量验收         |
| 当前真实 chatgpt.com 页面                | 未验证       | 扩展端到端通过的是测试页面，不等于当前真实网站兼容性已确认               |
| NSIS 安装、卸载和全新 Windows 用户全流程 | 未验证       | 此次实跑的是交付目录中的 `win-unpacked`，没有安装到用户系统              |

端到端首次运行受到测试环境 Electron 配置目录权限限制；切换到隔离的临时 APPDATA 并允许启动测试进程后通过。该环境问题不计为产品缺陷。

## 二、问题与修复要求

### R1 · P1：正常“预览备份→确认恢复”也会失败

位置：[appRuntime.ts:271](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:271)、[appRuntime.ts:298](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:298)、[archiveStore.ts:55](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/archiveStore.ts:55)。

通俗解释：预览时发了一张票，但确认恢复时换了一个不认识这张票的管理员。

- `previewRestore()` 创建一个新的 `ArchiveService`，凭证保存在该实例的内存 Map 中。
- `restoreData()` 又创建另一个实例，其 Map 是空的。
- 独立测试调用真实的 AppRuntime 方法，合法预览后确认，收到“恢复凭证无效：请先执行预览”。仅隔离了 HTTP 启停与日志，没有替换归档逻辑。

修复要求：凭证由同一个生命周期稳定的主进程服务管理，或由主进程统一保存并消费。保留一次性、有效期和先预览后确认的规则，不能靠取消凭证校验解决。

通过标准：真实桌面调用链预览后第一次恢复成功；伪造、过期、重复使用及未经预览恢复均被拒绝。测试不能只覆盖同一个 ArchiveService 实例。

### R2 · P1：恢复失败后，不能保证旧数据完整回到原位

位置：[archiveStore.ts:367](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/archiveStore.ts:367)、[archiveStore.ts:408](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/archiveStore.ts:408)。

独立测试在临时目录注入一次真实重命名步骤的失败，复现了两个不同窗口：

1. 旧数据库已移到备份，移动旧 vault 时失败。因为 `moved` 尚未设为 true，回滚被整个跳过，原位置的数据库不存在。
2. 新数据库已放入正式位置，放入新 vault 时失败。回滚只在正式数据库不存在时才恢复旧库，因此留下“新数据库＋旧 vault”。测试重新打开正式数据库，读到的是 incoming 项目，而不是原来的 old 项目。

备份仍然存在，不能把这描述为已证实的永久数据丢失；但自动恢复、原路径可用性和数据库与原文的一致性已经失败。

另有代码层面的配套缺口：[appRuntime.ts:311](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:311) 关闭了数据库；失败分支只重新启动 HTTP 服务，没有重新打开数据库、重建依赖服务或恢复任务队列。即使文件回滚成功，原来的内存服务仍可能引用已关闭连接。此项需增加运行时故障测试，不要只验证磁盘文件。

修复要求：按每一步实际完成情况回滚，保证数据库与 vault 一起恢复；替换失败后移开不完整的新数据，再恢复旧数据；最后恢复可工作的数据库连接、服务和队列。回滚失败要明确报错并保留备份，不能声称“原数据可用”。

通过标准：对每一个备份、替换和校验步骤分别注入失败；核对旧数据库、原文、证据关系，并确认界面读取及本地接口还能使用。R1 修好后必须重新验证真实桌面链路；当前两项测试直接调用归档恢复，是为了独立暴露被 R1 遮住的下游问题。

### R3 · P1：撤销授权后，仍有原文读取和后续模型发送

位置：[itemStore.ts:82](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/itemStore.ts:82)、[extractor.ts:72](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:72)、[extractor.ts:106](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:106)。

两个独立复现：

- 提取后撤销文件权限。普通来源阅读器已正确拒绝，但 `ItemService.getEvidence()` 仍返回完整片段正文和引用摘录。这条路径直接供桌面“理解依据”和纠正预览使用。
- 长文开始提取，在第一块模型调用返回时撤销授权。后续仍继续调用，实际共发送 4 块，而不是只停留在已发送的第一块。

原因：依据查询没有权限过滤；提取只在开始时检查一次权限，之后把预读进内存的所有块继续发送。

修复要求：每一个返回原文或摘录的出口统一检查权限；每次模型请求前重新检查，取消尚未发送的块，并在提交新理解前再次检查。已发送的网络请求无法“收回”，但撤销之后不能再发送新的内容。

通过标准：撤销后可显示“来源已撤销”的状态，不返回原文；运行中的提取不再发送后续块，也不把撤销后的结果提交为新理解。

### R4 · P1：模型引用不存在时，会把旧理解清空

位置：[extractor.ts:113](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:113)、[extractor.ts:140](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:140)。

复现：先成功生成一条理解，再让模型只返回不存在的 `S999` 引用。程序跳过这条错误结果，却仍然进入“删除旧理解”的事务。最终项目理解列表为空。

通俗解释：模型这次没交出合格答案，系统却把上一次的合格答案擦掉了。

修复要求：引用校验是整次替换的前置条件。出现无效引用时明确失败并保留旧状态，不能只增加 `skippedBadRef` 计数后继续替换。明确区分“合法分析结果为空”和“结果因校验失败全被丢弃”。

通过标准：错误引用、混合正确与错误引用、结构错误、模型中途失败和写库失败都不改变旧 current 理解及关联证据。现有 `extraction.test.ts` 仍有把“错误引用跳过”视为成功的旧断言，需要按上一轮修复契约更新，不能通过放宽本次验收断言掩盖问题。

### R5 · P1：引用编号真实，不代表引用的那句话真实

位置：[extractor.ts:118](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:118)、[extractor.ts:168](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:168)。

复现：让模型引用真实存在的 `S1`，但 excerpt 写成原文完全没有的 `FABRICATED_NOT_IN_SOURCE`。这句话仍被存入 `item_evidence`，作为“原文依据”交给用户。

修复要求：核验摘录确实来自所引用的片段，或让模型提供经程序校验的范围，再由程序截取原文。若允许空白规范化，规则应明确、有限且可追溯；不能把模型自编的概述伪装成原文引语。

通过标准：真实编号＋虚构摘录、属于别的片段的摘录都被拒绝；用户看到的每一段引文都能在对应原文中定位。

### R6 · P1：送给模型时，把“用户说的”和“AI 建议的”混成了同一种文档

位置：[extractor.ts:216](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:216)。

复现输入为一轮 user 和一轮 assistant，但模型实际收到：

```text
[S1]（doc）
我尚未同意执行。
[S2]（doc）
这是我的建议。
```

组装时硬编码了 `doc`，丢掉了原来的说话人身份。模型没有可靠信息区分用户决定和助手提议；这直接影响 IXAEON 最核心的“记住用户真正决定了什么”。此处已证实的是角色信息丢失，不是声称某个真实模型必然生成某条错误结论。

修复要求：保留真实 role，长段展开和重新拼块时同样保留。文档可以标为 document，但对话角色不能被统一改写。

通过标准：模型输入可识别 user、assistant 等真实角色；补充“助手提出方案、用户没有同意／明确否决”的真实语义验收场景，不能只测字符串出现过。

### R7 · P1：60 秒内的新内容会被保存，却可能再也不分析

位置：[localServer.ts:531](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:531)。

复现：开启自动分析，第一次采集触发一次回调；10 秒后新增一轮内容，成功入库但没有新回调；再推进 120 秒并重复提交相同内容，仍然只有最初的一次回调。

当前实现只是“60 秒内直接返回”，没有安排窗口结束后的补分析。重复提交因为 `acceptedCount === 0` 也不会补救。若第一次任务已经取走旧快照，第二批内容就可能一直没有进入理解。

修复要求：记录来源有未处理变更，合并短时间内的变更，在窗口结束或当前任务结束后补一次最新版本分析。排队／运行中不能直接丢掉再次分析的需求；补分析前复查权限、暂停和自动分析开关。

通过标准：连续到达的新内容最终都会进入最新一次分析，重复内容不造成重复任务；长任务执行期间再次更新也不会漏处理。可改变具体调度策略，但必须保证最终处理到最新版本。

### R8 · P1：不同对话可能被误合并，暂停状态也会在身份变化时失效

位置：[localServer.ts:422](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:422)、[localServer.ts:357](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:357)、[content.ts:55](D:/Agent/Project/OMNIX-IXAEON析衍/apps/extension/src/content.ts:55)。

两个独立复现：

1. 先提交一个临时对话，首句“你好”、后面有专属内容；再提交另一个同样以“你好”开头的正式对话。系统把两个来源合成一个，并把前一个对话的专属内容放进后一个对话的历史。
2. 暂停一个 `page:` 临时对话，然后以正式 `/c/…` ID 提交相同首句和新增内容。服务端返回 200，新内容入库；暂停没有延续。

原因：服务端仅凭首轮序号和正文 hash 推断是同一场对话；暂停检查只看本次传入的 ID。扩展的临时 ID 又来自路径和页面标题，两者都不是可靠的独立会话标识。

修复要求：采用能跨临时 URL→正式 URL 延续、但不同会话互不相同的采集会话标识；有可靠绑定关系才迁移身份，并同步迁移暂停等关联状态。证据不足时宁可保留为两个待核对来源，也不能仅凭相同开场白做破坏性合并。

通过标准：多标签、新对话重名／同首句、身份转正、暂停后转正、生成分支变化均有测试。身份变化不串资料，也不能绕过暂停。

### R9 · P2：自定义目录的勾选框在正常启动时也被禁用

位置：[Setup.tsx:29](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Setup.tsx:29)、[Setup.tsx:110](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/renderer/src/pages/Setup.tsx:110)。

程序用 `state.dataDir.length > 0` 判断是否有环境变量覆盖。但正常启动也会解析出一个非空默认目录，因此正常用户同样被禁止勾选自定义目录。

已在复制到仓库外的打包版上复现：明确移除 `IXAEON_DATA_DIR` 后，该 checkbox 仍为 disabled。

通过公开 IPC 绕过这个界面入口后，自定义目录保存、完整退出、重新启动和项目保留均通过。因此此次确认的阻塞点是界面判断，不应再把整条后端迁移流程一并称为未实现。

修复要求：由主进程明确返回实际的 envOverride／目录来源字段；不能用目录字符串非空来推断。

通过标准：普通安装启动可以勾选并完成界面设置；确实使用环境变量覆盖时才按设计禁用；通过真实界面完成一遍自定义目录重启测试。

## 三、现有验收材料需要修正的地方

1. `REVIEW_PACKET.md` 中“P1 全部修复”的结论不成立。逐项区分已实测通过、测试未覆盖、已复现失败和待人工验证。
2. 当前桌面 E2E 用开发版 Electron 加载 `out/main/index.js`。即使它叫“安装产物握手”，也不是仓库外的打包产物验证；原 E2E 的读写部分直接调用 HTTP，不等于经 STDIO 调用了工具。本次独立脚本已经补上后一条实际证据。
3. `docs/dev-log-fixes.md` 的安装包大小和哈希是旧值。当前文件为 122,562,744 字节，SHA-256：

   ```text
   9569DF834855CCF9D2CD21694D7CBE79BE1609F9345F5371A1E820272071BA04
   ```

   此值与当前 `REVIEW_PACKET.md` 一致。修复后重新打包时，两份材料都要同步。

4. 不得把真实文档检索命中和 FakeProvider 问答称为真实模型语义验收，也不得把受控测试页面称为当前真实 ChatGPT 网站验收。

## 四、交给修复 agent 的材料和命令

请同时阅读上一轮 [修复任务](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_v0.1_验收问题与修复任务.md)；这份报告不是放宽原要求，也不代表未列出的位置均已全面安全审计通过。

新增材料：

- [独立业务测试](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/review-20260905.test.ts)
- [独立测试配置](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/vitest.config.ts)
- [本次失败结果 JSON](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-20260905.json)
- [打包版 MCP／目录复核脚本](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/packaged-20260905.mjs)

在项目根目录执行：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.config.ts
node apps/desktop/test/review/packaged-20260905.mjs
```

当前第一条命令预期以 11 项失败退出；第二条命令预期输出“目录 checkbox 失败、后端重启通过、MCP 通过”后以状态 1 退出。它们是按正确行为写的验收断言，不是为了展示错误而刻意抛出的失败。

独立业务测试没有加入默认 Vitest 项目扫描，所以原来的 `verify` 全绿不代表这些场景通过。修复时应把这些场景纳入持续回归；如重构接口，可以调整测试接入方式，但不能降低权限、数据完整性和最终分析覆盖要求。

打包脚本会复制交付产物到新的临时目录、创建隔离的 APPDATA／LOCALAPPDATA、使用测试文档和空模型密钥，并在结束时关闭自己启动的进程。发现 43191 已有服务时直接停止，不触碰已有桌面实例。测试副本和临时资料保留供核查，没有写入真实用户数据目录。最后一次完整打包复核使用的临时目录是 `C:\Users\87953\AppData\Local\Temp\ixaeon-packaged-review-EV5dyj`。

本次添加的测试代码已通过类型检查和 lint。修复后的交付需再次运行常规 verify、E2E、独立测试，并重新构建打包产物后复测；不能只拿旧产物验证新源码。

## 五、建议修复顺序与再次交付条件

1. 先修 R1、R2：让恢复通路可用，同时保证失败时能回到完整旧状态。
2. 再修 R3、R8：堵住权限撤销、身份与暂停问题，避免继续产生越权读取或串档。
3. 修 R4、R5、R6：理解不能被错误结果清空，依据不能伪造，说话人不能丢失。
4. 修 R7：让新增内容最终真正进入分析，而不是仅仅存起来。
5. 修 R9、同步材料、补真实网站和真实模型验收证据。

再次交付请给出：新提交号、逐项修复说明、测试结果、新安装包哈希和明确的未验证清单。未经确认不要使用用户真实资料做恢复故障试验，也不要擅自启用收费模型。

**最终判断：工程基础已经可运行，但还没有达到可以放心托管项目记忆的状态。先完成上述可靠性和权限修复，再进入新功能。**
