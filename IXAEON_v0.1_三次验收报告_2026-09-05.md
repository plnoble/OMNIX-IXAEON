# IXAEON v0.1 三次验收报告

审核日期：2026-09-05。

审核提交：`8cb464302a8b89623ca673a946b50884ca116fa3`（`fix: 二次验收修复（R1-R9 全部）+ 材料同步`）。

## 结论：修复有明显进展，但仍暂不通过完整验收

上次失败的 11 项独立测试，这次全部通过。打包产物的目录选项、后端自定义目录重启，以及 MCP 四工具实际读写也通过了。

但对话身份、暂停与恢复的完整链路还没有修完。此次追加 13 项相邻场景检查，1 项正向对照通过、12 项失败，归为下方 6 组问题。新增检查继续验证原定 v0.1 的隔离、权限、恢复与限长要求，没有加入 Door 等新功能要求。

这里不能简单说“上次没修”，也不能简单说“旧测试全绿，所以全部修好了”：**原来的复现多数已解决，修复后的状态变化与异常分支仍存在缺口。**

建议暂时不要把真实项目资料当作唯一副本托管给这一版。先修完本报告中的 P1，再补真实网站与真实模型验收。

本次没有修改生产代码、旧验收测试或旧报告，只新增此次审核材料与测试。所有写入和故障注入都针对新建临时目录中的合成资料，没有调用真实模型或使用用户密钥。

## 一、本次实测结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `corepack pnpm verify` | 通过 | lint、格式、类型、16 项单元测试、98 项集成测试、构建，以及上轮 11 项独立回归 |
| `corepack pnpm test:e2e` | 通过 | 桌面 10 项；扩展配对、采集、流式内容、普通暂停／恢复等受控页面场景 |
| 上轮打包复核脚本 | 3 项全部通过 | 普通启动的自定义目录 checkbox 可用；公开 IPC 保存自定义目录后完整退出重启；仓库外产物、无全局 Node PATH 的 MCP 四工具调用及持久化写回 |
| 本轮相邻场景检查 | 13 项中 1 项通过、12 项失败 | 包含服务端、客户端身份逻辑、运行时恢复与故障注入；不是整个产品的随机抽样通过率 |
| 本轮新增代码的类型检查与 lint | 通过 | 失败来自业务行为断言，不是编译或测试框架装载失败 |
| 真实模型六组问答、当前真实 chatgpt.com | 未验证 | 未调用收费模型、未读取真实登录会话；受控测试页面和 FakeProvider 不替代这两项 |
| NSIS 安装／卸载、新 Windows 用户全流程 | 未验证 | 实测为 `win-unpacked` 测试副本，不是往用户系统安装 |

端到端使用独立的临时 APPDATA。打包复核副本位于 `C:\Users\87953\AppData\Local\Temp\ixaeon-packaged-review-2w9d9k`，测试进程在结束时已关闭。

交付安装包实际大小：122,566,050 字节；实际 SHA-256 与两份交付说明一致：

```text
4D9184DA61A62A1FA66524D9BC3173B2431A0160A50C45A41DDD9297D0845607
```

## 二、上轮 R1–R9 的复核结论

| 上轮问题 | 本次判断 |
| --- | --- |
| R1：合法恢复凭证不被识别 | 原复现通过，进程级共享凭证确实解决了实例隔离问题 |
| R2：恢复失败回滚和运行时不可用 | 原两处单次重命名故障通过；新增“单次 vault 安装失败→旧数据＋HTTP 可用”的正向对照也通过。但无效凭证、回滚自身失败、后台定时任务未退出仍有问题，见 N3–N5 |
| R3：撤销后读取依据／继续发送模型块 | 原两项复现通过：依据检查权限，每个模型块前复查权限 |
| R4：错误引用清空旧理解 | 原复现通过：错误引用现在中止替换、保留旧理解 |
| R5：虚构摘录入库 | 原复现通过：虚构摘录被校验拒绝；真实模型语义仍未验收 |
| R6：说话人角色丢失 | 原复现通过：user／assistant 角色保留；长段完整包装后的限长仍有小缺口，见 N6 |
| R7：60 秒内新内容永远不补分析 | 原复现通过，补分析计时器有效；但暂停和恢复没有妥善管理计时器，见 N3 |
| R8：串对话、身份变化绕过暂停 | 原两个特定样例通过；会话编号未完整接入，更多正常使用场景仍失败，见 N1、N2 |
| R9：自定义目录 checkbox 总是禁用 | 打包副本实测通过。已有脚本验证 checkbox 和后端重启，尚不是全程仅通过界面完成自定义目录选择的测试 |

## 三、仍需修复的问题

### N1 · P1：会话编号没有真正参与来源隔离，仍会串对话

位置：[localServer.ts:417](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:417)、[localServer.ts:541](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:541)、[localServer.ts:616](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:616)、[content.ts:124](D:/Agent/Project/OMNIX-IXAEON析衍/apps/extension/src/content.ts:124)。

通俗解释：扩展现在给对话发了“身份证”，但桌面端创建来源时没把身份证保存下来；查询时也主要还是看旧的页面地址。

实际复现（T1、T2、T3、T11、T12）：

- 提交带 `sessionId` 的临时对话，数据库 metadata 中没有该字段。另一个不同 sessionId 的正式对话只要包含相同首句，仍可能与前一个合并。
- 两个新对话标签页拥有同一路径、同一标题、不同 sessionId，分别发送完全不同的文本，最终返回同一个 sourceId。两份内容被当作同一来源的版本。
- 暂停临时对话后，使用同一 sessionId 转为正式 URL，但其中一轮回答变了：暂停没有继承，返回 200，新内容被保存。
- 客户端也把“内容是否包含上次全部文字”当成会话身份判据：两个不同正式 URL、相同内容，会拿到同一个 sessionId；同一正式 URL 重新生成回答，却拿到不同 sessionId。

根因：创建来源只写 `{ via, first_seen }`，没有保存本次 sessionId；已有来源查询仅用 external_id。服务端所谓“完整包含兜底”在临时来源只有一句“你好”时，仍退化为“仅首句相同就合并”。客户端的正文超集关系同样不能证明是同一场对话。

修复要求：

1. 创建临时来源时保存可靠的会话标识，临时来源的查找／隔离也必须使用它，不能只补一个未被查询使用的字段。
2. 不同正式 URL 是不同会话；同一正式会话编辑、重新生成回答不应改变会话身份。按会话生命周期处理临时 URL→正式 URL 的绑定，不能按正文相似性猜测。
3. 缺少可靠身份信息的旧客户端／历史数据，宁可保留为独立待核对来源，也不要用完整内容包含关系做破坏性合并。
4. 可靠身份映射建立后，暂停状态也必须跟随同一会话；不能要求旧文本仍一字不差地出现在新快照中。

通过标准：不同标签、同标题、同首句、同内容、编辑／重新生成、临时转正式均保持正确隔离；暂停不因内容修改失效。

### N2 · P1：对话转正后，用户点“继续”仍可能一直采集不了

位置：[localServer.ts:327](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:327)、[localServer.ts:445](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:445)。

实际复现（T4）：

1. 暂停 `page:draft-a`。
2. 正式 `/c/formal-a-123456` 到达，被正确拒绝，同时把正式 ID 加进暂停列表。
3. 用户明确恢复正式对话，接口返回 200。
4. 再次提交时仍返回 403。

原因：恢复操作只移除正式 ID，临时 ID 仍为暂停。上次拒绝时没有完成身份绑定或合并，下一批又遇到这个临时来源，把正式 ID 重新标为暂停。

修复要求：暂停应绑定到稳定会话，或通过持久的别名关系同步管理。允许只迁移必要的身份元数据、不采集新正文；用户明确恢复同一场对话后，所有有效别名必须反映同一个恢复状态。

通过标准：“暂停临时对话→身份转正→明确继续→成功采集”形成完整闭环；不能要求用户去找已经消失的临时页面取消暂停。

### N3 · P1：补分析计时器没有跟随暂停／恢复一起停止

位置：[localServer.ts:587](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:587)、[localServer.ts:601](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:601)、[appRuntime.ts:303](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:303)。

实际复现：

- T5：第一次采集后 10 秒再来一批内容，安排了补分析；随后用户暂停该对话。窗口结束后仍触发第二次自动分析回调。计时器只检查总开关、自动分析开关和域授权，没有检查该对话的暂停状态。
- T6：同样先安排补分析，然后完成一次合法恢复，接口已经返回 `restartRequired: true`。继续等待计时器，抛出 `TypeError: The database connection is not open`。此时旧数据库确实已被关闭，但 LocalServer 的计时器仍在运行。

后一项已证实的是后台定时回调访问关闭的数据库并抛异常；本次没有据此声称已实测某种用户界面崩溃表现。

修复要求：为 LocalServer 的后台任务建立明确的停止／清理生命周期；暂停、删除、身份绑定、恢复和应用退出时处理对应的 pending 状态与计时器。关闭数据库前先停止相关回调，补分析真正执行前再检查稳定会话的暂停和授权状态。任务队列中已经排队但尚未执行的自动任务，也应遵守关闭／暂停后的规则。

通过标准：暂停后不再触发待补分析；恢复成功后等待超过一个完整防抖窗口，没有旧回调访问数据库；应用停止时无残留计时器。保持原 R7 的最终分析覆盖能力，不能通过直接移除补分析功能解决。

### N4 · P1：拒绝一次无效恢复凭证，会让后续合法恢复报“文件被占用”

位置：[appRuntime.ts:318](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:318)、[appRuntime.ts:342](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:342)。

实际复现：

- T7：无效凭证被拒绝时，旧数据库连接仍然开着，旧任务队列也没有停止；运行时却又打开一个连接、创建一个新队列并覆盖原来的引用。
- T7b：随后正常预览，并用刚拿到的合法凭证恢复。在当前 Windows 环境真实报 `EBUSY: resource busy or locked, rename ... ixaeon.db`。这一项没有注入文件系统故障；就是前一步遗留的连接造成数据库被占用。

原因：所有恢复错误都无条件进入 rebuild。无效／过期凭证或预校验失败发生在 `closeCurrentDb()` 之前，此时原运行时本来还可用，不需要也不能直接叠加第二套服务。

修复要求：根据恢复实际进行到哪一步决定处理方式。原连接未关闭、磁盘未变化时复用原运行时；确实需要重建时，先完整停止并释放旧队列／连接。不要吞掉关闭失败后继续替换文件。

通过标准：无效、过期、重复凭证和损坏包被拒绝后，只剩一套有效运行时；紧接着使用合法预览凭证可以成功恢复，不需重启来解锁文件。

### N5 · P1：回滚自身失败后，会新建空数据库并重新启动服务

位置：[archiveStore.ts:438](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/archiveStore.ts:438)、[archiveStore.ts:456](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/storage/archiveStore.ts:456)、[appRuntime.ts:323](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:323)。

实际复现（T8）：在安装新 vault 和回滚旧 vault 两个重命名步骤分别注入失败。归档层正确报“回滚未完成”，但 AppRuntime 仍然无条件 rebuild：因为正式位置此时没有数据库，`openDatabase()` 创建了新空库，`migrate()` 建好空表，随后仍调用启动 HTTP 服务的逻辑。正式库里的项目列表变成空数组，而不是 old 项目。

这不等于已证实旧数据永久丢失：该场景的旧数据还在备份目录。问题是，程序在磁盘状态未恢复完整时，仍把一个空库作为正常运行数据库继续使用。

修复要求：把“没有改动磁盘”“已完整回滚”“回滚未完成”作为不同结果处理。仅在确认原数据完整可用后恢复运行；否则进入明确的恢复故障状态，保留备份位置，禁止自动创建空库和恢复正常写入。日志也不能断言“数据文件完好”。

通过标准：回滚自身失败后不出现新的正常空库，不启动正常写入任务；用户可看到准确的故障和备份信息。普通单次替换失败仍需自动恢复可用。

正向对照 T9 已通过：仅让新 vault 安装失败一次，文件回滚后，AppRuntime 重建成功，项目列表保留 old，MCP HTTP `prepare_task` 返回 200。这证明这里需要细分恢复状态，而不是推翻已修好的整个回滚实现。

### N6 · P2：长段子块的编号后缀仍可能突破 8000 字符上限

位置：[extractor.ts:221](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:221)、[extractor.ts:248](D:/Agent/Project/OMNIX-IXAEON析衍/packages/core/src/extraction/extractor.ts:248)。

实际复现（T10）：一个 30,000 字符、role=user 的无换行片段，完整包装后最大块为 8001 字符。

原因：切分只按 `[S1]` 的头部长度预留空间，第二块实际使用 `[S1.2]`；发现超限的兜底分支反而直接发送超限块。

这是较小的边界问题，不是本轮最主要的阻塞，也不能据此断言模型调用一定失败。但它不符合此前明确约定的完整 user 文本不超过 8000 字符。

修复要求／通过标准：按真实编号和角色头计算每块容量，超限时重新切分；覆盖二位及更多位后缀和超长无换行文本，所有完整块都必须在上限以内。

## 四、复现材料与命令

新增材料：

- [本轮服务端与恢复测试](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/lifecycle-round3.test.ts)
- [客户端会话身份测试](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/identity-round3.test.ts)
- [本轮独立配置](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/vitest.round3.config.ts)
- [13 项实跑结果 JSON](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-round3-20260905.json)

在仓库根目录运行：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.round3.config.ts
```

当前应为 12 failed、1 passed；T9 是通过的正向对照。T7b 的 EBUSY 是实际 Windows 文件占用错误，T8 的双重重命名失败是刻意故障注入；两者不能混写。

测试使用真实核心服务、SQLite、Fastify 路由和实际 AppRuntime 方法。对 AppRuntime 仅隔离 HTTP 监听启停和日志；T9 另用真实路由注入验证重建后 HTTP 读取。客户端测试用 jsdom 装载实际 content.ts 并调用其导出方法，浏览器宿主消息与观察器被隔离。因此这些测试不能冒充真实 ChatGPT 网站人工验收。

此次测试独立于现有 verify 配置，尚未自动纳入持续回归；原来的 verify 全绿不能代表新增场景通过。修复时应将这些行为纳入回归。可以随合理重构调整测试接入方式，不能降低隔离、暂停和恢复条件。

测试使用的临时资料和打包副本保留用于核查；没有安装、删除或恢复用户真实数据。

## 五、下一轮交付要求

1. 优先修 N1、N2 的可靠身份与暂停／继续闭环。
2. 修 N3–N5：后台任务跟随运行时停止，按实际状态处理恢复失败，尤其覆盖无效凭证后再恢复与回滚自身失败。
3. 修 N6，保持旧 11 项回归和常规测试通过，并将新增场景纳入持续验证。
4. 重新构建打包产物，再跑打包复核脚本；提供新提交号、安装包哈希和逐项状态，不能用旧安装包替新代码作证。
5. 真实模型问答、当前真实网站、安装／卸载流程继续明确标注是否完成，不要用 mock 检索或开发版 E2E 替代。

已有开发基础不需要推倒重来；本轮需要完成的是 **R2、R7、R8 的状态与生命周期闭环**，以及一个限长边界修正。在这些条件满足前，不应宣告 v0.1 完整验收通过。
