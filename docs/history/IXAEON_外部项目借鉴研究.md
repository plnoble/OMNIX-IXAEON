# IXAEON 外部项目借鉴研究

记录时间：2026-09-04  
状态：架构参考，不表示采用这些项目或立即增加开发范围

## 1. 研究目的

IXAEON 同时涉及个人记忆、自动采集、设备协作、权限、任务执行和 AI 推理。只研究其他“AI 助手”容易把注意力集中在聊天界面和模型能力上，却忽略设备离线、数据冲突、任务失败和隐私边界等更基础的问题。

这次研究的判断标准不是“项目听起来是否先进”，而是：

- 它解决了 IXAEON 的哪个具体问题；
- 它的机制是否已经经过真实使用；
- IXAEON 应借鉴设计、接入现成项目，还是暂时不做；
- 借鉴后是否仍符合“用户拥有原文、权限可撤销、过程可解释”的原则。

## 2. 当前最重要的结论

IXAEON 不应该被开发成一个什么都自己实现的巨大程序。更合理的结构是：

```text
来源观察器 / 导入器
        ↓
用户拥有的原文仓库
        ↓
可追溯的提取与记忆层
        ↓
任务规划器：硬条件 + 软偏好
        ↓
可信设备与 Door 执行
        ↓
执行轨迹、实测结果和失败恢复
```

其中每一层都有现成项目可以参考，但没有任何一个项目可以整体变成 IXAEON。

## 3. Home Assistant：设备和能力要分开

Home Assistant 使用 Device Registry 保存设备，用 Entity 表示设备暴露出来的具体能力或状态。例如一个温湿度传感器是一个设备，但可以拥有温度、湿度和电池三个 Entity。

### IXAEON 可以借鉴

- Door 本身是一台设备；
- “可运行小模型”“当前电量”“可做 OCR”“有摄像头”等是设备暴露的能力或状态；
- 每项能力需要稳定 ID，不能依赖会变化的 IP、主机名或用户显示名称；
- 用户改名只改变显示名称，不改变内部身份；
- 同一个现实设备通过不同连接方式被发现时，不能轻易重复创建，也不能只凭名称合并。

### 对 IXAEON 的具体影响

Device Registry 不应把整台设备存成一大块随意变化的 JSON。建议长期分为：

```text
Device：设备身份、型号、所有者、配对关系
Capability：设备能提供的功能与上限
State：电量、温度、网络、在线状态等短期状态
Permission：用户允许的操作和数据范围
```

参考：https://developers.home-assistant.io/docs/device_registry_index/

## 4. Fleet 与 osquery：统一询问不同系统

Fleet 在每台 Windows、macOS 和 Linux 设备上运行轻量 Agent，通过 osquery 把操作系统、硬件、软件和安全配置表示成统一的可查询数据。它还把很多规则表达成简单的“通过/不通过”问题。

### IXAEON 可以借鉴

- 不同操作系统可以有不同探测实现，但向主 IXAEON 提供同一套语义；
- 除了读取详细指标，还应支持简单的 Policy Check；
- Policy Check 应同时带解释和解决办法，而不是只给红灯。

Door 可以回答：

```text
是否适合处理私密资料？       通过
是否允许使用蜂窝网络下载模型？ 不通过：用户未授权
是否可以执行 30 分钟任务？    不通过：iOS 后台无法保证存活
是否满足本地模型要求？        通过：安全可用内存 5.2 GB
```

不建议直接把完整 osquery/Fleet 塞进 Door。应先借鉴它的“跨平台统一查询 + 可解释策略检查”方法。

参考：https://fleetdm.com/docs/rest-api/rest-api

## 5. KubeEdge：必须区分“想让设备怎样”和“设备实际上怎样”

KubeEdge 使用 Device Twin 保存设备的期望状态和实际状态，并在边缘与中心之间同步。边缘节点断开中心后仍能保存本地状态并继续有限运行。

### IXAEON 可以借鉴

主 IXAEON 发出命令，只能改变 `desired_state`；只有 Door 真正执行并回报后，`reported_state` 才能改变。

例如：

```text
desired_state：开始照片索引
reported_state：等待充电
reason：battery_below_policy
```

不能因为主 IXAEON 已经下令，就在界面上显示“正在执行”。更不能因为网络断开，就猜测任务成功。

还应借鉴它把管理信息和原始数据分开的思路：主 IXAEON可以收到“已处理 800 张图片”，不等于所有图片都必须上传到主节点。

参考：

- https://release-1-19.docs.kubeedge.io/docs/architecture/edge/devicetwin/
- https://release-1-21.docs.kubeedge.io/docs/developer/dmi/

## 6. Nomad 与 Kubernetes：先过滤，再评分

Nomad 把调度规则分成：

- `constraint`：必须满足的硬条件；
- `affinity`：满足更好，但不满足也可能执行的软偏好。

Kubernetes 又区分设备的总容量 `capacity` 和真正可分配容量 `allocatable`，并通过状态与 taint 表示节点内存不足、磁盘压力、网络不可用或暂时不应接收任务。

### IXAEON 可以借鉴

一次任务不应直接给所有设备打一个混合总分。正确顺序是：

1. 先用硬条件排除绝对不能用的设备；
2. 再对剩余设备按照软偏好评分；
3. 保存每台设备被接受或排除的原因；
4. 执行前由 Door 再做一次本地检查。

例子：

```text
硬条件：资料不能离开可信设备；至少 4 GB 安全内存；支持语音转写
软偏好：正在充电；局域网速度快；用户不在使用；过去成功率高
```

还应有类似 Drain 的状态：用户准备关机、带走电脑或进行维护时，可以让设备停止接新任务，已有任务完成、暂停或迁移，而不是突然消失。

参考：

- https://developer.hashicorp.com/nomad/docs/concepts/scheduling/placement
- https://developer.hashicorp.com/nomad/commands/node/drain
- https://kubernetes.io/docs/reference/node/node-status/
- https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/

## 7. BOINC：把家庭设备当成不稳定的志愿者

BOINC 长期处理来自普通个人电脑的闲置算力。这些电脑会关机、断网、被用户使用、运行速度估计错误，也可能返回错误结果。

### IXAEON 可以借鉴

- Door 主动领取合适任务，比主节点假设 Door 永远在线更稳妥；
- 用户可以限制电池、运行时间、CPU、内存、磁盘和联网条件；
- 任务应带预计资源、截止时间、输入引用和输出要求；
- 调度估计要根据真实完成时间不断校正；
- 离线设备可以保存少量任务，但不能一次领取过多；
- 反复失败的设备应该自动降低派工量，而不是无限重试；
- 对不能容忍错误的重要计算，可以在另一台设备复算或执行结果校验。

这比简单的“手机空闲时多干点活”完整得多。IXAEON 的机会式 Worker 应把掉线和失败当成正常情况，而不是异常情况。

参考：

- https://boinc.berkeley.edu/boinc_papers/locality/text.php
- https://boinc.berkeley.edu/boinc_a_platform_for_volunteer_computing.pdf

## 8. Tailscale：设备加入网络前先证明自己是谁

Tailscale 的设备需要身份与批准，访问规则按来源和目标表达，并由设备在本地执行。新的待批准设备不能先加入网络、以后再补权限。

### IXAEON 可以借鉴

- 每个 Door 生成自己的设备密钥，设备 ID 不能只是随机数据库编号；
- 新设备先进入 `pending_approval`，批准前不能读取资料或接受任务；
- 允许 A 访问 B，不等于自动允许 B 访问 A；
- 规则默认拒绝，只有明确授权的路径才开放；
- 失窃设备必须可以从其他可信设备撤销；
- 本地 Door 应执行权限，不应只相信主节点说“已经检查过”。

早期实现不必自己解决所有 NAT 穿透问题。IXAEON 可以优先支持局域网，并把 Tailscale 一类网络作为可选连接层。

参考：

- https://tailscale.com/docs/features/access-control/device-management/device-approval
- https://tailscale.com/docs/features/access-control/acls

## 9. Syncthing：同步时不要相信“最后保存的人一定正确”

Syncthing 使用设备证书指纹作为 Device ID，通过 TLS 连接，把文件拆成带哈希的块传输。它不会直接覆盖目标文件，而是先写临时文件、验证后再替换；两台设备同时修改时，会保留冲突副本。

### IXAEON 可以借鉴

- 大文件断点传输和内容哈希验证；
- 临时写入完成后再原子替换，避免中断产生半个文件；
- 同步原文时保留冲突，不让算法擅自决定哪份人生记录“才是真的”；
- 每个原文和派生结果都保存内容哈希；
- 设备被移除后撤销其同步权限；
- 中继服务器只帮助连接，不应自动获得明文内容。

特别需要注意：同步文件和同步“记忆结论”不是一回事。原文冲突可以保留两个版本；由 AI 提取出来的结论则应回到来源和证据重新计算。

参考：

- https://docs.syncthing.net/users/security.html
- https://docs.syncthing.net/users/syncing.html

## 10. Temporal：任务不能因为程序重启就失忆

Temporal 的核心思想是 Durable Execution：工作流经历程序崩溃、网络失败或长时间中断后，可以从已经记录的位置继续，而不是重新猜测做到哪一步。

### IXAEON 可以借鉴

IXAEON 的长任务需要持久状态机：

```text
planned → awaiting_approval → dispatched → running
        → paused / retry_wait → completed / failed / cancelled
```

每个外部操作必须考虑幂等性。例如“再次总结文件”问题不大，但“再次删除文件”“再次发消息”可能造成严重后果。Door 应用心跳报告进度；心跳停止后，主 IXAEON 只能判断为失联或待确认，不能直接判定失败并无脑重做。

Temporal 本身对早期 IXAEON 可能过重。第一步应借鉴事件历史、状态恢复、心跳、超时和幂等键，是否实际接入 Temporal 以后再决定。

参考：https://docs.temporal.io/

## 11. ActivityWatch 与 Screenpipe：自动采集要做成独立观察器

ActivityWatch 把采集器称为 Watcher：窗口、浏览器、编辑器和离开键盘状态分别由独立模块观察，再送进本地服务。它也明确区分实时 Watcher 与历史 Importer。

Screenpipe 更进一步，可以持续采集屏幕、音频、OCR 和转写，并在本机存储和搜索。这说明“给 AI 自动补充用户经历”在技术上可行，但也说明其隐私风险非常高。

### IXAEON 可以借鉴

IXAEON 的来源接入应分成三类：

```text
Connector：通过应用官方接口读取，例如邮箱、日历、聊天平台
Importer：用户导入历史导出包或文件
Watcher：在本机持续观察以后发生的事件
```

每个观察器拥有自己的：

- 开关、权限和采集范围；
- 原始事件桶；
- 断点位置和最后成功时间；
- 排除的 App、窗口、网址和时间段；
- 保留周期与删除按钮；
- 是否允许进入 AI 提取流程。

### 应采用的渐进原则

1. 优先使用官方 Connector；
2. 没有接口时先提供 Importer；
3. 再考虑只记录应用名、时间和会话标识的轻量 Watcher；
4. 全屏截图、录音和键盘级采集属于最高敏感级，默认关闭；
5. 过滤必须在 Door 本机、写入磁盘和上传之前发生；
6. 用户能随时看到“现在正在采集什么”，并一键暂停。

因此，IXAEON 自动读取用户与 AI 的对话，不应一开始就靠全天候录屏解决。Watcher 是接口缺失时的最后补充手段，不是默认入口。

参考：

- https://activitywatch.net/
- https://docs.activitywatch.net/en/latest/architecture.html
- https://docs.activitywatch.net/en/latest/watchers.html
- https://screenpipe.com/security

## 12. Letta：模型当前能看到什么，也是一种权限

Letta 把长期可见内容组织成 Memory Blocks，并允许把某个 Block 动态附加到 Agent，任务结束后再卸下。这说明记忆不只需要“存在哪里”，还需要“这次运行允许模型看到哪些”。

### IXAEON 可以借鉴

- 把“长期保存”与“当前放进模型上下文”分开；
- 每个任务只装载完成任务所需的记忆片段；
- 敏感记忆可以临时授权，任务结束后撤下；
- 多个执行 Agent 可以共享只读的任务资料，而不必复制成多份失控记忆。

### IXAEON 不应照搬

不能让模型直接自由改写唯一的权威记忆。模型可以提出候选记忆，但 IXAEON 应保存来源、提取版本、置信度和修改历史；涉及身份、长期偏好与重要事实的变化，应支持用户检查和回滚。

参考：https://docs.letta.com/tutorials/attaching-detaching-blocks/

## 13. Solid：数据归用户，应用只是被允许来使用

Solid 的核心思路是把个人数据保存在用户选择的 Pod 中，不同应用通过授权读取或写入，而不是每个应用都占有一份封闭副本。

### IXAEON 可以借鉴

- 原文仓库属于用户，不属于某个模型供应商或聊天界面；
- 模型和 Agent 是可替换的数据使用者；
- 权限附着在具体数据范围和具体动作上；
- 用户更换模型或界面时，记忆不应被锁死；
- 每份资料有稳定标识，便于引用来源和撤销授权。

不必立即采用 Solid 的 RDF、Pod 或完整协议。第一步借鉴它的所有权模型：**数据中心不等于控制中心，主 IXAEON 也不能因为负责整理就取得无限读取权。**

参考：

- https://solidproject.org/TR/2021/protocol-20211217
- https://solidproject.org/TR/sai

## 14. exo：多机推理应先看网络拓扑，再决定怎么拆

exo 会自动发现设备，并根据设备资源以及设备之间的实时延迟、带宽选择模型并行方式。它还提供 placement preview，在真正加载模型前列出有效的部署方案和每个节点增加的内存占用。

### IXAEON 可以借鉴

- 多机协作不能只比较 RAM，还要测量设备之间每条连接的延迟和带宽；
- 先预览模型如何放置、各设备占用多少，再真正执行；
- 统一兼容 OpenAI、Claude、Ollama 等常见 API，可以降低上层调用耦合；
- 没有算力但网络位置合适的设备可以只做协调，不一定同时做 Worker。

### IXAEON 的取舍

Door 早期不自己实现模型切片。主 IXAEON 应把 exo、MLXHub 或以后出现的同类系统视为一种 `distributed_model_provider`。只有当普通的任务级调度不能满足真实需求时，才进入模型层级的分布式推理。

参考：https://github.com/exo-explore/exo

## 15. OpenTelemetry：一次任务要能从头追到尾

OpenTelemetry 把可观测信息分成 Trace、Metric 和 Log，并使用统一语义名称，让不同语言和不同组件产生的数据能够关联。

### IXAEON 可以借鉴

- 每次任务生成 `trace_id`；
- 主 IXAEON 的计划、权限检查、Door 接收、模型调用和结果提交属于同一条 Trace；
- Metric 记录耗时、峰值内存、温升、耗电、Token 和失败率；
- Log 记录状态变化和可供排障的原因，但不默认记录原文、提示词或密钥；
- Door 字段需要版本化的统一名称，不能让 Windows、iOS、Android 各自随意命名。

这会让用户以后能够得到一句可靠解释：

> 这项任务原计划交给手机，但手机因低电量拒绝；随后台式机在权限检查通过后执行，用时 42 秒，没有把原文发送到外部网络。

参考：

- https://opentelemetry.io/docs/concepts/signals/
- https://opentelemetry.io/docs/concepts/semantic-conventions/

## 16. 建议吸收顺序

### 第一批：现在就进入设计

1. Home Assistant：Device、Capability、State 分离；
2. KubeEdge：期望状态与实际状态分离；
3. Nomad：硬条件与软偏好分离；
4. ActivityWatch：Connector、Importer、Watcher 分离；
5. Syncthing：内容哈希、临时写入和冲突保留；
6. Tailscale：设备身份、待批准和默认拒绝；
7. OpenTelemetry：统一任务 Trace 与设备指标语义。

这些主要是数据结构和边界，不要求立即引入大型依赖。

### 第二批：Door 开始执行任务时采用

1. BOINC：机会式领取、截止时间、实测校准和失败降权；
2. Temporal：持久任务状态、心跳、超时、幂等和恢复；
3. Kubernetes/Nomad Drain：设备优雅退出任务池；
4. Fleet：跨平台体检与策略检查。

### 第三批：真实需求证明后再做

1. exo、MLXHub：模型级多机推理；
2. Screenpipe：持续屏幕和音频采集；
3. Solid 完整协议：跨应用个人数据 Pod；
4. mycellm 公共算力与积分网络。

这些方向很有想象力，但过早开发会迅速扩大隐私、安全和运维范围。

## 17. 建议形成的 IXAEON 共通语义

综合这些项目后，IXAEON 可以先稳定以下概念：

```text
Source         原始资料来自哪里
Artifact       用户拥有的原文或文件
MemoryClaim    AI 从原文提出的候选记忆
Device         一台经过配对的现实设备
Capability     设备能做什么
State          设备现在怎样
Permission     用户允许谁对什么数据做什么
Task           可执行、可取消、可恢复的工作
Plan           执行前的候选设备、排除理由和预计成本
Attempt        一次具体执行尝试
Result         带来源、校验和资源实测的结果
Trace          从决定到结果的完整过程
```

这些概念比先选择某种数据库、消息队列或 Agent 框架更重要。技术可以替换，含义一旦混乱，系统会越来越难解释。

## 18. 一句话结论

> IXAEON 最值得借鉴的不是某个项目的全部功能，而是把成熟系统中的现实经验拼成一套一致原则：数据归用户、设备先证明身份、状态不靠猜、任务先过滤再评分、执行可以拒绝和恢复、冲突不会被悄悄覆盖、每个结论和动作都能追溯原因。
