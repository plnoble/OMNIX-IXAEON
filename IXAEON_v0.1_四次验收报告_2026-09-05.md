# IXAEON v0.1 四次验收报告

审核日期：2026-09-05。

审核提交：`ea9da6266439cc60943a9ecc37c0e654ebd79331`（`fix: 三次验收修复（N1-N6 全部）+ 材料同步`）。

## 结论

**本轮修复有效，但仍不通过 v0.1 完整验收。**

上两轮的 24 项独立回归，这次全部通过；常规验证、桌面与扩展端到端测试、打包产物复核也通过了。

不过，进一步按日常操作测试，发现“刷新后重复建档”“多草稿漏分析”“无效恢复操作丢掉待分析工作”“关闭自动分析后排队任务仍调用模型”等问题。新加的 7 项检查中，6 项失败，1 项正向对照通过，归为下方 F1–F4。

这些不是新增 Door 或多设备需求，而是原定 v0.1 的刷新去重、持续分析和用户控制要求。也不是说之前的修复全部无效：**原来被测到的场景已经修好，完整的身份和任务生命周期还没有统一。**

下一阶段计划见 [IXAEON_下一阶段开发计划_v0.1.1到v0.2.md](D:/Agent/Project/OMNIX-IXAEON析衍/IXAEON_下一阶段开发计划_v0.1.1到v0.2.md)。先完成稳定性收口，再推进单项目日用闭环。

## 一、审核范围与实测结果

阅读了最新 `REVIEW_PACKET.md`、`docs/dev-log-fixes.md`、本轮生产代码差异、原开发计划和此前验收报告，并检查相关上下游代码。

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| `corepack pnpm verify` | 通过 | lint、格式、类型、16 项单元、98 项集成、构建、前两轮 11 + 13 项独立回归，共 138 项测试 |
| `corepack pnpm test:e2e` | 通过 | 桌面 10 项；扩展配对、受控页面采集、流式内容、普通暂停与恢复等 |
| 打包产物复核 | 3 项通过 | 目录选择开关；公开 IPC 设置目录后完整进程重启；仓库外打包副本在无全局 Node PATH 条件下完成 MCP 握手、四工具调用及持久化写回 |
| 本轮独立检查 U1–U7 | 1 通过、6 失败 | 真实本地服务、SQLite 与生产任务处理器；合成数据、FakeProvider，不访问真实账户或模型 |
| 新增测试的 lint、类型检查 | 通过 | 失败来自业务断言，不是测试装载或编译失败 |
| 当前真实 chatgpt.com、真实模型语义问答 | 未验证 | 受控网页和 FakeProvider 不能替代真人环境验收 |
| NSIS 安装／卸载、新 Windows 用户全流程 | 未验证 | 本次启动的是 `win-unpacked` 临时副本，没有安装到用户系统 |

本轮没有修改生产代码、旧报告或旧测试。新增了测试、测试结果、本报告和下一阶段计划。测试数据仅写入独立临时目录；没有读取模型密钥或调用收费模型。

打包复核临时副本：`C:\Users\87953\AppData\Local\Temp\ixaeon-packaged-review-8ylcRT`。测试进程已退出，副本保留用于核查。

安装包 `apps/desktop/release/IXAEON-Setup-0.1.0.exe` 实际大小为 122,568,319 字节，SHA-256 与交付说明一致：

```text
D9F8530A45A4F0EA73B3D38456B22A93822C0055B1A9BAC67D5CD88C412D91F7
```

## 二、问题与修复要求

### F1 · P1：把页面采集会话误当成了对话身份

位置：[localServer.ts:518](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:518)、[content.ts:122](D:/Agent/Project/OMNIX-IXAEON析衍/apps/extension/src/content.ts:122)、[localServer.ts:668](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:668)。

通俗解释：同一篇文章换一个窗口打开，不能当成另一篇文章。现在扩展刷新后会生成新的采集编号，服务端却把编号变化直接理解成“新对话”。

实际复现：

- **U1**：同一正式 `/c/formal-123456`、相同正文，先后使用刷新前后两个 sessionId。第二次返回 HTTP 400，错误为 `UNIQUE constraint failed: sources.provider, sources.external_id, sources.content_hash`；数据库已有 2 条来源记录，而不是 1 条。
- **U2**：同一正式 URL 重新打开，增加一条回答并使用新 sessionId，两次均返回 200，但 sourceId 不同，原对话被拆成两个来源。
- **U3**：同一临时页面地址下，草稿 A、草稿 B、再次更新草稿 A。最终产生 3 个来源，而不是 2 个，第二次 A 没有找回自己的来源。

根因：只查询同一 externalId 的最新来源；sessionId 不同就忽略查到的来源。这既不区分正式 URL 与临时页面，也没有按 sessionId 查找较早的草稿 A。新来源插入与后续内容更新不在同一数据库事务中，失败后还留下额外来源记录。

修复要求：

1. 区分“稳定对话身份”和“本次页面采集实例”。同一正式对话 URL 不因刷新、新标签页或新 sessionId 而换 sourceId。
2. 无正式 ID 的草稿按明确的草稿身份查找，不能只拿同路径最新一条记录来比较。
3. 保持不同草稿、不同正式 URL 的隔离；不能用“正文相同／标题相同”证明它们是同一对话。
4. 临时身份转正后，项目归属、暂停状态、片段依据及既有引用必须延续。
5. 来源创建和片段登记保持数据库事务一致性。冲突应完整回滚或明确去重，不能留下半成品记录；不要用删除唯一约束掩盖身份错误。
6. 补真实浏览器 `reload()`、关闭重开、多标签页、A→B→A，以及升级旧数据库的测试。

### F2 · P1：多个草稿共用一个分析计时器，已收到的内容会漏分析

位置：[localServer.ts:717](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:717)、[localServer.ts:742](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:742)。

实际复现 **U4**：同一临时页面地址的三个独立草稿 A、B、C，分别在第 0、10、20 秒采集，全部保存成功；再推进 120 秒，只有两个 sourceId 收到自动分析通知，C 没有。

根因：来源已经能分成三个，`lastAutoEnqueue`、`pendingAnalysis` 和 `trailingTimers` 却仍按 externalId 共用一份。B 建立计时器后，C 遇到“已有计时器”就返回；回调捕获的仍是 B 的 sourceId。

修复要求：

1. 分析合并和排队以稳定来源身份为单位，不以临时网页地址为单位。
2. 同一来源的多次更新可以合并，不同来源不能互相覆盖；身份转正也不能丢工作。
3. 不只验证队列长度，要验证每个应分析来源的最新内容最终都得到处理。

### F3 · P2：恢复请求被拒绝后，原有待分析工作消失

位置：[appRuntime.ts:304](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:304)、[localServer.ts:217](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/server/localServer.ts:217)。

实际复现 **U5**：对话先被分析一次，10 秒后又收到新回答，正在等待窗口末尾补分析。此时用无效恢复凭证调用恢复接口，接口正确拒绝，但再等待 120 秒，第二次分析没有发生。

根因：在校验恢复凭证之前，就调用 `stopBackgroundTasks()` 清空待分析状态。早期失败分支虽然复用了原数据库并重启 HTTP，却没有恢复已清掉的工作。注释中的“原运行时保持可用”不等于原工作完整保留。

修复要求：

1. 无效、过期、校验失败等未实际替换数据的恢复请求，不得丢失已接收数据的待处理意图。
2. 可以先完成必要预检，或在失败后重建待处理工作；不能重新保留会访问已关闭数据库的旧计时器。
3. 成功恢复、完整回滚、回滚失败三条路径仍须满足此前 N3–N5 测试。
4. 下一阶段将“有新内容尚未分析”持久化，避免业务可靠性仅依赖内存计时器。

### F4 · P1：自动分析开关只管排队入口，不管实际执行

位置：[appRuntime.ts:192](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/appRuntime.ts:192)、[ipc.ts:338](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/src/main/ipc.ts:338)。

实际复现 **U6**：自动提取任务已排队，随后将 `capture.autoAnalyze` 关闭，再运行实际生产队列和提取处理器，FakeProvider 仍收到 1 次模型请求。对照 **U7** 保持开关开启，任务正常调用模型并成功，说明不是测试把执行链路弄坏了。

这里没有实际向云端发送资料；验证的是生产代码会发起模型调用的路径。

根因：自动任务 payload 已带 `auto: true`，但提取处理器只读取 sourceId，不读取自动标记或当时的开关状态。排队时允许，不代表执行时仍被允许。

修复要求：

1. 自动任务在真正执行前，重新检查自动分析开关、采集开关、来源授权、该对话暂停状态；不满足时不得调用模型。
2. 把检查接到实际执行链路，包括重试任务，而不是只修计时器或界面显示。
3. 在多块提取间和结果提交前复查相关条件，接入取消信号。已经发出的网络请求无法承诺撤回，但之后不得继续发新块或把取消结果当作最新理解。
4. 区分自动分析与用户明确点击的手动分析：关闭自动分析不应永久封死仍获授权的手动操作。撤销来源授权则两者都禁止。
5. 取消／暂停应有可见状态，不得假装提取成功；恢复开关后的补分析应覆盖最新内容且不无限重复。

## 三、复跑方法与证据

新增测试：[continuity-round4.test.ts](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/continuity-round4.test.ts)。

原始结果：[results-round4-20260905.json](D:/Agent/Project/OMNIX-IXAEON析衍/apps/desktop/test/review/results-round4-20260905.json)。

在仓库根目录运行：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/test/review/vitest.round4.config.ts
corepack pnpm verify
corepack pnpm test:e2e
node apps/desktop/test/review/packaged-20260905.mjs
```

本轮独立测试当前退出码为 1，是上述业务失败的预期记录；常规验证、端到端和打包复核的通过情况见第一节。端到端与打包复核应顺序执行，避免抢占固定端口；若检测到用户运行中的服务，停止测试，不要杀掉用户进程。

U1–U3 使用服务端输入复现浏览器重新生成 sessionId 后的行为；客户端模块级变量在页面刷新后重置由代码确认，**不是已在真实 ChatGPT 登录页面实测刷新**。U4–U5 使用虚拟时钟；U5 隔离了监听端口，仅调用实际恢复流程的早期拒绝分支；U6–U7 使用真实队列和处理器、FakeProvider。修复后还应补客户端与服务端串联测试。

修复 agent 应保存本次失败记录，另存修复后的结果，不要覆盖历史证据；将这组测试纳入默认验证入口。若身份协议需要变更，可以调整测试适配层，但不得弱化“不重复、不串对话、不漏分析、关闭后不再自动调用”的业务断言。

## 四、下一轮放行条件

1. F1–F4 修复；U1–U7 与此前 24 项独立回归全部通过。
2. 增加真实浏览器生命周期到真实本地服务的串联测试，不能继续只让扩展对着假接收端通过。
3. 常规验证、端到端、重建产物后的打包复核通过；源码、安装包哈希和交付说明一致。
4. 真实网站、真实模型语义、安装器人工验收仍须补齐，未做的继续明确标为“未验证”。不得以测试数量替代这些证据。

建议先用非敏感测试资料和已有原始备份试用；当前版本不应被当作项目资料的唯一保管位置。
