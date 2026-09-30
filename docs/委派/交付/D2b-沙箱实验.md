# D2b 沙箱实验交付说明（调研，交整合方定稿，不合并）

- 分支：`prep/D2b-spike`　日期：2026-09-30　状态：调研结论，推送不合并
- 任务来源：用户指派的两项调研之一——「D2 沙箱跑真实测试」的第二轮（D2b），
  回答 D2 报告（`docs/委派/交付/D2-沙箱实验.md`）§9 未闭环的问题，尤其是
  §9.4「junction 写穿真实依赖的缓解方案未实验」。
- 上层文件仅为证据：实验脚本 `scripts/real/d2b-e1-helper-auth.mjs`、
  `d2b-e2-main.mjs`、`d2b-e3-auth-check.mjs`（无源码改动、无验收测试改动、
  无迁移）。
- 隐私：全部用合成项目与临时目录；仓库文件不含本机绝对路径（运行期由
  `tmpdir()` 推导）；不打印真实记忆/会话内容；没跑 `codex exec`、没调模型。

## 1. 要回答的七个问题（用户指定）

1. 固定 CODEX_HOME + 一次性 UAC 授权后，连续 10 次无人值守能否可靠跑？
2. 授权是绑定 CODEX_HOME，还是全机器一次？
3. 有没有不弹窗的授权状态检查方法？
4. junction 链接真实 node_modules，提权沙箱里 vitest 能不能跑、能不能
   写穿真实依赖？
5. 联网、向副本外写文件是否被拦？
6. 沙箱带来多少计时开销？
7. 结论怎么落进 D2 规格（三档划分）；验证失败报告怎么写才不吓人；
   首次授权怎么引导？

## 2. 结论（先给答案）

| 问题         | 答案                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 无人值守   | **连续 10/10 成功**（含改完 profile 后再跑 10/10），中途无弹窗                                                                                                         |
| 2 授权范围   | **按 CODEX_HOME 绑定**：cap_sid、.sandbox-bin helper、setup 标记都在各自 HOME 下；只有沙箱用户（CodexSandboxOffline/Online）、Windows 服务、防火墙规则是机器级一次安装 |
| 3 免弹窗检查 | 有：读 4 个被动文件/服务状态即可判定（`d2b-e3-auth-check.mjs` 实测 4/4 PASS，exit 0，全程无弹窗）                                                                      |
| 4 junction   | 读可行（`import('dep')` 成功）；**写穿被拦**（EPERM，真实依赖目录项数 7→7 不变）；vitest 在沙箱内跑通 **1 test PASSED**                                                |
| 5 联网/越界  | 联网 BLOCKED（沙箱用户级防火墙）；写副本外 BLOCKED（EPERM，文件未落盘）                                                                                                |
| 6 开销       | 合成单测项目：沙箱内 999ms vs 沙箱外 606ms；日志显示每次启动有约 300–400ms 固定开销（setup refresh + 读 ACL 应用）                                                     |
| 7 规格落地   | 依赖档建议改用「专用 CODEX_HOME + elevated 沙箱」承载（见 §6），零依赖档/拒绝档不变                                                                                    |

## 3. 实验办法（真机检查，可复现）

环境：Windows 11；codex CLI `0.130.0-alpha.5`；Node `D:/Development/Node.js/Install/node.exe`（v24.14.0）。
专用 HOME 固定为 `<系统临时目录>/ixaeon-d2b-home`，profile 如下（这是本轮
实验挖出的**可用配方**，写在 HOME 的 `config.toml`）：

```toml
[permissions.<档案名>]
[permissions.<档案名>.workspace_roots]
"<工作区>" = true
[permissions.<档案名>.filesystem]
"<临时目录>/**" = "read"          # 真实依赖所在只读区（junction 读的源）
"<工作区>/**"  = "write"          # 副本内可写（写能力的唯一来源）
[permissions.<档案名>.network]
enabled = false
[permissions.default_permissions]
extends = "<档案名>"
```

统一入口：`codex sandbox windows --permissions-profile <档案名> -c windows.sandbox="elevated" -C <工作区> -- <命令>`。
脚本 `d2b-e2-main.mjs` 一次跑完 T1/T4/T5/T6，输出落 `<tmp>/d2b-main-last.txt`；
最后一遍（2026-09-30 早）原样摘录如下（路径以 `<tmp>` 代替本机临时目录）：

```
== T1 连续 10 次无人值守（专用 HOME 已授权） ==
T1-1..T1-10: exit=0 PASS ×10
T1 汇总：10/10

== T4 junction 挂真实依赖：读可行、写真实依赖被拦 ==
T4 输出：
READ_DEP=dep-real
WRITE_THROUGH=BLOCKED(EPERM)
WRITE_INSIDE=ALLOWED
T4 真实依赖里是否真出现写入文件：false

== T5 联网被拦 + 写工作区外被拦 ==
T5 联网：
NETWORK=BLOCKED(EACCES)
T5 越界写：
ESCAPE=BLOCKED(EPERM)
T5 越界文件是否存在：false

== T6 vitest 计时对比 ==
T6 沙箱外：exit=0 耗时 606ms
T6 沙箱内：exit=0 耗时 999ms
T6 沙箱内输出全量：
 RUN v5.0.0 <tmp>/ixaeon-d2b-work/vitest-proj
 ✓ src/add.test.ts (1 test) 2ms
 Test Files 1 passed (1)
      Tests 1 passed (1)
 Duration 196ms (transform 54%, import 31%, worker 10%, tests 6%)
T6 真实 node_modules 目录项数 前=7 后=7（写透应被拦，数目不该变）
```

sandbox.log（HOME 下 `.sandbox/sandbox.log`）同轮关键行：

```
setup refresh: processed 2 write roots (read roots delegated); errors=[]
granting write ACE to <tmp>/ixaeon-d2b-work for sandbox group and capability SID
```

## 4. 过程发现（把 D2 报告没闭环的洞补齐）

1. **写能力的唯一来源是 filesystem 表里的 `"write"` 子树条目。**
   本地 profile 会由 codex 编译成 `PermissionProfile::Managed`，Windows
   提权沙箱只看 `writable_roots_for_cwd` 是否非空来选
   `WritableRootsCapability` / `ReadOnlyCapability`。此前多轮
   `sandbox_mode="workspace-write"`（CLI `-c` 与 profile 内）**均不生效**：
   日志一直是 `read-acl-only mode`、`processed 0 write roots`，一切写入
   EPERM。`workspace_roots` 只圈工作区，不授予写；`writable_roots` 不是
   profile 字段（写了被静默忽略）。recipe 见 §3。
2. **提权授权按 CODEX_HOME 绑定**：`cap_sid`（workspace/readonly/
   workspace_by_cwd 三类 SID）、`.sandbox-bin/codex-command-runner-<版本>.exe`、
   `.sandbox/setup_marker.json` 都在各自 HOME 下；复制 helper 二进制到新
   HOME 不构成授权（e1 实验：无 helper 的新 HOME 得到 1223 = 授权缺失，
   复制 helper 后仍失败），**必须由提权 setup 在该 HOME 生成 cap_sid**——
   这一步就是用户要点的那一次 UAC。机器级部分（沙箱用户、服务
   CodexSandboxService.OpenAI.Codex、WFP 回环防火墙）一次装好常驻。
3. **免弹窗检查成立**：`d2b-e3-auth-check.mjs` 只做被动读取（cap_sid 三类
   SID 键与目录数、版本配对 helper、setup 标记、服务 RUNNING），实测全部
   PASS、无任何弹窗；缺哪项输出哪项，正好用作首启引导的判定。
4. **junction 写穿被 OS 级拦住**：真实依赖目录只有读 ACE，没有该 HOME
   能力 SID 的写 ACE；无论进程还是其 vitest 子进程经 junction 写入真实
   node_modules，操作系统直接 EPERM。T6 里 Vite 想写
   `node_modules/.vite-temp`（junction 指向真实依赖区）被拦，正是这一层的
   体现。D2 报告 §6.2「junction 写穿风险待拍板」此路可解，且为 OS 级，
   不依赖 Node 权限模型。
5. **vitest 在沙箱内跑通的三个必要条件**：
   - `--config-loader runner`：默认 bundled loader 会把配置打包写进
     `node_modules/.vite-temp` → 经 junction 落真实依赖区 → EPERM；
   - `cacheDir` 指到副本内（`.vitest-cache`）：默认 `node_modules/.vite`
     同样写穿被拦；
   - `shell_environment_policy.inherit=all` + TMP/TEMP 指到工作区内：提权
     helper 默认清洗环境变量，vitest 的 SSR 临时目录会落用户级
     `%TEMP%`（只读）→ EPERM；inherit=all 后落到工作区内可写。
6. **网络阻断在 OS 层**：PROFILE 里 `enabled=false`，沙箱运行后 fetch 直接
   EACCES；且 D2 E2 已经证明 Node `--permission` 完全管不住网络——elevated
   沙箱把这一条也一并补掉了。越界写（副本外写文件）EPERM、未落盘。
7. **临时目录 HOME 的警告**：CODEX_HOME 落在 `%TEMP%` 下时每个命令都会打
   「Refusing to create helper binaries under temporary dir」并跳过 PATH
   更新，但实验证明授权与运行不受影响（helper 由 UAC setup 生成后直接复用）；
   为稳妥，产品化时建议把专用 HOME 放在非临时目录（如应用数据目录），
   消掉这条警告。
8. D2 报告 §9.2「helper 一次性安装后长期可靠未验证」：本轮补齐——10/10。

## 5. 四分开

- **已实现**：3 个实验/检查脚本（合成数据、临时目录、无模型调用）＋本说明。
  没有产品源码改动。
- **自动化通过**：本次为调研，没有写验收测试、没有改任何 locked 测试；
  `node scripts/verify.mjs` 未跑（分支只加 scripts/ 与 docs/，不涉代码路径；
  若整合方要求可补跑一并贴出）。推送后以 CI 结果为准。
- **真机通过**：T1 10/10、T4 读通+写拦+区内可写、T5 联网/越界双拦、
  T6 沙箱内 vitest 1 passed/exit 0、e3 授权检查 4/4——原样输出见 §3，
  摘要存档在 <tmp>/d2b-main-last.txt 与工作树 `.logs/`（不入库）。
- **用户接受**：未验证——调研结论待整合方定稿后落入 D2 规格才涉及用户。

## 6. 对 D2 规格草稿三层的最终建议（供整合方拍板）

零依赖档（默认）与拒绝档保持 D2 草稿不变。**依赖档**建议从
「Node --permission 旗标集 + junction（写穿风险待拍板）」改为
「专用 CODEX_HOME + elevated 沙箱」：

- 验证跑法：`codex sandbox windows --permissions-profile <档案> -c windows.sandbox="elevated" -C <副本> -- <IXAEON 验证 node> node_modules/vitest/vitest.mjs run --config-loader runner`；
- HOME/档案初始化：首启引导用户点一次 UAC（cap_sid 生成），此后无人值守；
  运行前用 e3 式被动检查判定，缺授权时：
  - **失败报告建议**：不显示「沙箱初始化失败 (exit 2)」这类吓人字样，
    而是「任务 X 的验证在受控沙箱里执行前需要一次 Windows 授权，点这里」，
    附一条跳转按钮走引导；验证结果里标 `verify_status=failed, reason=unauthorized`，
    与「跑挂了」的 failed 分开渲染；
  - 授权在、沙箱在、依赖缺/测试挂 → 才走原有失败路径。
- 契约调整点：
  - defaultCheck 仍剥离命令自带 `--permission/--allow-*`；依赖档不再靠
    Node 权限模型（E2 的 8 旗标集退役为兜底），改由产品注入 codex 包装参数；
  - 副本内仍需 junction 挂真实 node_modules（读用），写穿由 OS ACL 兜底，
    mitigation 不再待拍板；
  - vitest 的 `cacheDir` 与 TMP/TEMP 由产品指到副本内（e3 三个必要条件
    是规格验收的第 2 条要覆盖的内容）；
  - 打包环境 ELECTRON_RUN_AS_NODE=1 缺口（D2 §7.1）照旧必须先修，否则
    两档在打包版都不可用，与本建议正交。
- 未定项留给整合方：专用 HOME 放置位置（建议应用数据目录、避开系统临时
  目录）；「一部机器多个 HOME 授权」与产品卸载时沙箱残留的处理。

## 7. 文件清单（分支新增）

| 文件                                | 行数   | 作用                                                                                 |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| scripts/real/d2b-e1-helper-auth.mjs | ~118   | A/B/C：无 helper 1223、复制 helper 不构成授权、授权跟 HOME（证据：helper 复制≠授权） |
| scripts/real/d2b-e2-main.mjs        | ~170   | T1/T4/T5/T6 主实验，输出 <tmp>/d2b-main-last.txt                                     |
| scripts/real/d2b-e3-auth-check.mjs  | ~95    | 免弹窗授权状态检查（N1–N4，exit 0/1/2）                                              |
| docs/委派/交付/D2b-沙箱实验.md      | 本文件 | 交付说明                                                                             |

## 8. 已知缺口（如实）

1. 10/10 只在同一台机器、同一 HOME、同一 codex 版本一天内验证；跨重启、
   跨版本升级后的 helper/cap_sid 失效场景**未验证**（授权检查脚本能查出，
   但恢复路径未跑）。
2. 没有测「依赖档」在 IXAEON 自身执行器（defaultCheck/打包版）里的集成——
   本轮只验证沙箱能力本身；集成属 D2 规格实现范围。
3. profile 的 glob 只验证了 `/**` 子树读与子树写两种形态；`:workspace_roots`
   符号与 deny 语法未穷尽。
4. 沙箱内计时只有单测合成项目的两个数据点（999/606ms）；真实项目规模下
   的开销未测。
