# 规格草案 C1：IXAEON Core Service —— 从桌面软件成长期服务

> dev2 按用户 2026-10-28 任务书**大块六**起草。**草案，不是生效规格；不写实现。**
> 依赖位置：Goal Engine → Memory → Reflection/Heartbeat → 7-Day Eval → Self-Improvement → **本块** → Router。
> **上游五块未并入/未定稿前，本块不得开工**（任务书「不要为了并行破坏逻辑关系」）。

## 1. 要什么（原文 1 节）

FAEX1 长期开机时，**即使 Electron GUI 没开，IXAEON 也必须继续工作**。
把核心从 Electron Application 逐步拆成 IXAEON Core Service。

## 2. 现状实测（先查再写，逐项给位置）

| 能力（原文 4 节的 10 项） | 现状 | 证据 |
| --- | --- | --- |
| 单实例 | ✅ 已有 | `apps/desktop/src/main/index.ts:56` `requestSingleInstanceLock`（+ `second-instance` 聚焦） |
| 优雅关闭 | ✅ 已有（Electron 形态） | `index.ts:100` `before-quit` 先停运行时再退 |
| 更新后重启 | ✅ 已有（Electron 形态） | `updater.ts:130-131` `quitAndInstall` |
| 开机启动 | ❌ 无 | `setLoginItemSettings`/autostart 全仓零命中 |
| 健康检查 | ❌ 无 | core 内 `health/readiness` 零命中 |
| 状态查询 | ⚠️ 只活在大进程里 | 桌面 HTTP 面唯一落点在 `appRuntime.ts`（**3041 行**，整个文件 `import electron`） |
| 崩溃恢复 | ⚠️ 部分 | JobQueue 有退避重试与持久化；**进程级**崩溃恢复没有（运行时就活在 Electron 主进程里） |
| 数据库恢复 | ⚠️ 部分 | WAL + busy_timeout 在；`archiveStore` 有备份还原，但无启动自检流程 |
| 任务恢复 | ✅ 基础好 | `JobQueue`（`jobs/jobQueue.ts`）持久队列、kind 去重、退避 |
| 日志 | ✅ 已有 | logger 分层（`component` 子 logger） |

**结论：十项里 4 项已有（都长在 Electron 形态上）、3 项有基础、3 项零基础。**

## 3. 最有价值的既有资产（解耦不是从零做）

- `packages/core/src/runtime/jsonrpcStdio.ts`：`JsonRpcStdio extends EventEmitter`，完整 JSON-RPC 帧；
- `packages/core/src/runtime/tuiGateway.ts`：**已经是一个不依赖 Electron 的宿主**——通过 transport 跑同一套 runtime；
- `a06-core-unified` 集成测试守着「核心能力不绑桌面」这条线；
- `apps/mcp`：MCP server 侧已存在，但**现状是「转发到本机桌面端 HTTP」**（`index.ts:19` 注释）——
  桌面端一关，MCP 就断。**这正好与验收 §5「关着 Electron 接 MCP」直接冲突，是 C1 的第一块要改的。**

## 4. 约束（原文 3 节，照抄 + 具体化）

**第一阶段不重写全部代码。** 优先做四件：
1. Core 生命周期从 Electron 解耦；
2. 支持独立启动；
3. Electron 变成连本机 Core 的 Client；
4. Core 不开 UI 也能跑定时任务。

具体形态（与 H1 附录 A、S1 §5.2 已有决定咬合，不另发明）：

- **Core Service = 独立进程**，暴露 JSON-RPC（复用 `JsonRpcStdio` 的帧格式；传输从 stdio 扩一条本机回路）；
- **H1 早已定了这条路**：HeartbeatRunner 宿主无关，「未来 IXAEON Core Service Adapter 接管时换 adapter」——
  C1 提供的就是这个 adapter 的落点，**两边不要各拆一套生命周期**；
- **S1 §5.2 的「配置快照/哈希」由 C1 的配置承载点提供**：Service 持配置版本，S1 的回滚才有的可指——
  这条依赖关系要在两边文档里互指（S1 已写「配置版本化是 S1c 硬依赖」）；
- **appRuntime 3041 行的拆法必须增量**：先抽「无 Electron 依赖的运行时核」，Electron 侧变成 client；
  不许一次性重写（超过 300 行规则 + 审不动）。

## 5. 拆分、档位与依赖

| 支 | 内容 | 档位 | 依赖 |
| --- | --- | --- | --- |
| **C1a** | 运行时核从 appRuntime 抽出（不 import electron 的 core 生命周期），桌面端改连它 | **B**（改变进程与数据写入权威边界） | 上游五块并入 |
| **C1b** | 独立启动入口 + 单实例（Service 形态）+ 优雅关闭 + 崩溃后自起 | B（新的进程生命周期权威） | C1a |
| **C1c** | 开机启动（Windows 计划任务/服务或等效）、更新后重启的 Service 化 | B（改系统级配置，需另行授权） | C1b |
| **C1d** | 状态查询 + 健康检查端点（复用 JSON-RPC 面，不新造协议） | A | C1b |
| **C1e** | MCP 与 Notification 改连 Core（断开对桌面 HTTP 的依赖） | B | C1b |

## 6. 验收（原文 5 节，逐条可执行）

关闭 Electron 后，Core 继续：跑 Heartbeat / 跑 Research / 跑任务 / 保存 Memory / 接 Feishu / 接 MCP。
**之后重开桌面端：看到期间发生的所有变化。**

落成测试矩阵（真实世界验收优先，原则 5）：

| # | 步骤 | 断言 |
| --- | --- | --- |
| 1 | Service 起，桌面端**未启动** | 心跳/研究/任务各产生一条真实记录（合成数据环境下） |
| 2 | 期间 Memory 写入 | `items` 新增行，来源链完整 |
| 3 | MCP 客户端在桌面端关闭期间连 Core 查询 | 返回成功（现状会失败——这条是回归门） |
| 4 | 杀掉 Service 进程（崩溃模拟） | 自起恢复，任务恢复、无双跑（单实例 + lease） |
| 5 | 重开桌面端 | **§1-4 的全部变化在 UI 可见**（这条是本块的产品级验收） |
| 6 | 桌面端开着时 Core 的定时任务照跑 | 不与 UI 抢资源到超时（沿用给聊天让路的既有规则） |

## 7. 不做什么

- 不做多机分布式（那是大块九）；不在此块接 Android/Web/扩展（只保证它们连的是同一个 Core）；
- 不重写 3041 行 appRuntime；
- Relay **不**升格为 Core Service 宿主（原则 1：Relay 只管开发流水线，不当总调度大脑）;
- 不在验收里用「测试全绿」代替「关 GUI 真跑」——本块的成立标志只有 §6 的真机序列。

## 8. 待统筹拍板

1. Service 在 Windows 上的落地形态：计划任务 + 守护？Windows Service？Electron 无关的 node 常驻？
2. 本机回路的传输选型（named pipe / loopback HTTP / stdio 由 supervisor 拉起）——涉及与现有桌面 HTTP 面的取舍；
3. 与 DSH/hermes 运行时的关系：Core Service 是否复用 `tuiGateway` 的宿主形态直接对外；
4. 桌面端连接本机 Core 失败时的降级策略（排队重连？提示用户？）。
