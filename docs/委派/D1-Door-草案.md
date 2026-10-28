# 规格草案 D1：Door —— 设备能力系统

> dev2 按用户 2026-10-28 任务书**大块八**起草。**草案，不是生效规格；不写实现。**
> 顺序：… → R1 → **本块** → 多设备 → 更多 Executor。

## 1. 要什么（原文 1 节）

IXAEON 应理解 FAEX1 / NAS / 红魔 / 星耀14 **分别能做什么**。
**Door 不是远程 Shell，是设备能力入口。**（这句定性进代码注释与所有后续设计。）

## 2. 重大现状发现：**休眠地基**

Migration 24 `door-devices-persistence` 已在 main 建了三张表，**生产代码零引用**
（`git grep` 只命中 `migrations.ts` 自身；AGENTS 把 Door 列为「停在设计稿，不要顺手实现」）：

- `door_devices`：name / platform / status(`online|offline|restricted|revoked`) /
  `capabilities_json` / cpu_cores / total_ram_mb / storage_gb / `local_models_json` /
  **`token_hash`**（配对凭证）/ telemetry_json / paired_at / last_heartbeat_at
- `door_benchmarks`：kind(`ram_stress|inference_speed`) / result_value / tested_at / **`expires_at`** /
  UNIQUE(device_id, kind)
- `door_task_leases`：task_id PK / device_id / **lease_until** / status(dispatched…)

**草案决定：D1 建立在这批表之上，不推翻重建。** 理由：
1. 表形状与大块八要求几乎一一对应（Identity=表本体、Pairing/Heartbeat=token_hash+paired_at+last_heartbeat、
   Online State=status、Static Capability=cores/ram/storage、Tested=benchmarks、Dispatch=leases）；
2. `expires_at` 正是 R1「Last Verified」要的形态（R1 草案已注记抄这个模式）；
3. 若整合方判定要改（`token_hash` 算法、benchmarks 的 CHECK 枚举扩展、多 kind 唯一约束等），
   **走新追加迁移，不改写已发布迁移**（AGENTS 硬规矩）。
4. 唯一要警惕的：这批表从未被真实代码用过，等于**没验过的纸面**——D1a 的第一件事是
   给「表 ↔ 运行时行为」补上真实回归，而不是在纸面上再叠设计。

## 3. 第一阶段（原文 2 节）：只接一台真实设备

优先 FAEX1。八件套逐一落点（全部对上 §2 的休眠列，缺的标出）：

| 要求 | 落点 | 缺什么 |
| --- | --- | --- |
| Device Identity | `door_devices.id/name/platform` | id 生成与防克隆（建议首次配对生成 device key，细节待拍板） |
| Pairing | `token_hash + paired_at` | 配对流程（扫码/输入码/局域网发现？）、token 轮换与吊销 |
| Heartbeat | `last_heartbeat_at` | 间隔与「多久算 offline」的判定（可配置默认，同 H1 §13.4 口径） |
| Capability | `capabilities_json` | **枚举词表**（见 §4，不许自由字符串） |
| Resource Status | `telemetry_json` | 结构定义 + Current State 分开（§4） |
| Permission | `status='restricted'` 粗粒度 | **细粒度授权**：哪类任务、哪类数据可在此设备执行——大概率要新列/新表（迁移归整合方） |
| Online State | status 四态 | 网络分区时 `restricted` vs `offline` 的区分规则 |
| Task Dispatch | `door_task_leases` | 派发即写 lease 的事务；lease 过期回收；cancel 传播 |

## 4. Capability 三层（原文 3 节，红线：**不许从型号推断性能**）

```text
Static   —— CPU/GPU/RAM/Storage/OS        = door_devices 列（事实申报）
Current  —— 负载/可用内存/磁盘/网络         = telemetry_json（瞬时值，带采集时间）
Tested   —— 真跑过的性能                    = door_benchmarks（带 expires_at，过期即不可用于派发决策）
```

- Tested kind 现在 CHECK 只允许 `ram_stress|inference_speed`；任务书要求
  **模型速度/编译速度/Embedding/Research/Coding/长时间负载** —— 扩枚举属追加迁移，整合方落；
- **过期即失效**：`expires_at` 过了，派发决策必须把该设备从对应 kind 的候选里剔除
  （与 R1 §6-3 的 last_verified 淘汰同构，可共用测试形态）；
- benchmarks 的 UNIQUE(device_id, kind) 意味着只保最新一次——历史是否保留**待拍板**
  （建议保留历史：S1 §4 说回归要看逐例变化，只留最新会丢趋势）。

## 5. 验收（原文 4 节）

1. Core 能报「**FAEX1 在线**」——数据来自真实心跳，不是手工插入；
2. 能看到：当前资源 / 已安装工具 / **已测试模型（带 tested_at 与 expires_at）** / 能执行哪些任务类型；
3. **真派发一个低风险任务**（候选：Research 子任务或 Embedding 基准——可逆、无外发）；
4. 结果**回到原 IXAEON Task**（沿用 `coding_tasks`/JobQueue 的 result 链，不新建回传轨道）；
5. 拔线测试：设备中途离线 → lease 过期 → **有副作用的任务绝不重复执行**（这条是 §6 幂等的验收形态）。

## 6. 与九/十的边界

- 多设备调度（大块九）**必须等 D1 单机稳定**后另立草案——本草案不含；
- 设备上的执行进程属于 Executor Contract（大块十）：设备**不拥有** Goal/Memory/身份（原则 4）；
- 设备侧通信是**新的外部网络面 = B 档**，配对与 token 管理属权限与隐私 = B 档。

## 7. 待统筹拍板

1. 配对流程形态（局域网发现/输入码/扫码）与 token 轮换策略；
2. Permission 细粒度模型的形状（新表还是列）；
3. benchmarks 是否留历史（§4）；
4. FAEX1 的 OS/运行时前提（systemd? node 版本?），决定心跳与执行进程的形态。
