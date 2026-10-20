# L0b 补完实验 交付

- 分支：`dev/L0b`；档位 **B**（花少量真额度；一次提权改了系统里的沙箱设置）
- 规格：[L0b-补完命令行和沙箱提权实验](../L0b-补完命令行和沙箱提权实验.md)
- 版号：Codex **`0.163.0-alpha.10.2`**、Claude Code **`2.1.304`**、DSH **`0.2.1-rc.2`**
- 提权：**只做了一次**（用户 2026-10-20 在对话里点了「好，可以提权」），`codex sandbox setup --elevated --current-user --codex-home <一次性目录>`

**一句话结论：新版 Codex 的沙箱现在是**能用的**——装一次（一次 UAC）之后，同一个 CODEX_HOME 不带任何提权动作连跑 10/10 成功、不弹窗、中位 1.15s；但**每次调用都必须显式带 `windows.sandbox="elevated"`**，而且**换一个新的 CODEX_HOME 又要重新提权**（从后台会话发起的提权弹不出来，会以 `ShellExecuteExW … 1223` 失败）。DSH 那一列仍然调不动，原因找到了：**headless profile 里凭据插件是关着的**。**

## 结论表

| 部分          | 问题                                        | 结论                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **甲** DSH    | 最小真调用能不能成                          | **不能**：起得来、能建会话、能吐 JSONL，但模型调用报 `MISSING_CREDENTIAL … provider route "deepseek-official"`（exit 1）。原因见下（凭据插件在 headless 里 `disabled: true`），不是 key 没配                                                                                                                                                                                         |
| 甲            | 结果从哪个字段取                            | `{"type":"final","text":…}` 是最终回答；一轮的过程在 `status`（`turn_start`/`step_start`/`step_end`/`turn_end`）里；会话号在第一条 `{"type":"session","sessionId":"session-…"}` 里                                                                                                                                                                                                   |
| 甲            | 能不能关在一个目录里                        | **设置上有**（`sandbox-policy`：`mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`、`workspaceRoot = process.cwd()`；预设 `read-only` / `workspace-write` / `danger-full-access`，审批 `ask`/`never`），**实测没有**（调不动，写文件那两步跑不出来）                                                                                                                      |
| 甲            | 按会话号续 / 与 Claude 并发 / `~/.dsh` 变化 | 前两条没有数据；`~/.dsh` 每次都只动一个文件：`profiles/headless/cordis.yml`（223 字节，修改时间变）                                                                                                                                                                                                                                                                                  |
| **乙** Claude | 白名单写文件                                | **没做**：Claude 的会话额度用完了（`api_error_status: 429`、`usage_limit_reached`、「resets 3:10am (Asia/Shanghai)」），到 3:10 之前任何 `claude -p` 都直接退 1。L0 的结论不变：不开权限就写不了                                                                                                                                                                                     |
| **丙** Codex  | 按会话号续                                  | **通过**：第一次 `thread_id=01a159f8-4a1d-7f80-b3bf-d5982e401933` 让它记住合成的词 `zq7k`，`codex exec --json --skip-git-repo-check resume <thread_id> …` 第二次答出 `zq7k`（exit 0，两次分别 17.9s / 23.7s）                                                                                                                                                                        |
| **丁** 提权   | 弹了几次、成没成、装了什么                  | **弹 1 次**（用户点「是」），`Windows elevated sandbox setup completed for <本机账户> at <CODEX_HOME>`，exit 0。机器上：服务 `CodexSandboxService.OpenAI.Codex` 仍是 RUNNING（没重建）、本地账户仍是 `CodexSandboxOffline`/`CodexSandboxOnline`（没新建）、**防火墙里带 Codex 的规则 33 → 34 条**；沙箱自己的日志显示它给离线沙箱用户配了 loopback/出入站封锁规则 + 12 条 WFP 过滤器 |
| 丁            | **装一次之后还要不要每次提权**（最要紧）    | **不用**：同一个 CODEX_HOME 带提权设置连跑 **10/10 成功**、全程 **0 次超过 5 秒**（中位 1.15s、1.08–1.56s），没有任何提权动作。**但换一个新的 CODEX_HOME（home-B）第一次就失败**（`orchestrator_helper_launch_canceled: ShellExecuteExW failed to launch setup helper: 1223`，等了 122.86s）→ 提权是**每个 CODEX_HOME 一次**，不是整台机器一次                                       |
| 丁            | 不带提权设置呢                              | **0/10 成功**：不带 `windows.sandbox="elevated"` 时每次都是 `Restricted read-only access requires the elevated Windows sandbox backend`（0.1–0.28s）→ 那个设置**不是「安装开关」，是每次调用都要带的**                                                                                                                                                                               |
| 丁            | D2c 的问题 3（沙箱里跑 vitest）             | **能跑**，但要给它一个可写的临时目录：直接跑时 vite 在系统临时目录里 `mkdir` 被拒（`EPERM … mkdir '<本机>\LekV-…\ssr'`，合成用例 1 failed）；把 `TEMP`/`TMP` 指到副本里之后 **1 passed**                                                                                                                                                                                             |
| 丁            | 问题 4（联网挡不挡得住）                    | **外网挡得住、本机端口挡不住**：连 `1.1.1.1:443` 被拒（`EACCES`）；连本机 `127.0.0.1:<随机端口>` **连上了**（详细见下面「已知缺口」第 6 条）                                                                                                                                                                                                                                         |
| 丁            | 问题 5（往外写挡不挡得住）                  | **挡得住**：副本里写成了；往副本外写 `EPERM`；经目录链接（`copy/node_modules` → 真 `node_modules`）往真实依赖写也 `EPERM`，落盘取证两次都没有那个文件                                                                                                                                                                                                                                |
| 丁            | 问题 8（开销）                              | 沙箱外整条命令 0.92s / 沙箱里 2.19s；固定 CPU 活（600 万次循环）沙箱里 8–9ms、外面 10ms → **CPU 本身没有可测出的额外开销**，差的是 `codex sandbox` 自己的启动（约 1.1s/次）                                                                                                                                                                                                          |
| 丁-4          | 默认配置目录还报 `.sandbox-bin` 加锁失败吗  | **不报了**：`codex exec --json --skip-git-repo-check -s workspace-write "只回三个字母：OK"` 用**默认 `~/.codex`** 跑，exit 0、23.2s、答 `OK`，输出里没有任何 `.sandbox-bin` / `helper_sandbox_lock` 字样。只看没修                                                                                                                                                                   |

## 最终的「后台调用配方」

### Codex（依赖档 / 审核档）

一次性（**需要用户在场点一次 UAC**，从后台会话发起会以 1223 失败）：

```
codex sandbox setup --elevated --current-user --codex-home <专用 CODEX_HOME>
```

之后每次调用（**不提权、不弹窗**，`CODEX_HOME` 用上面装过的那个）：

```
codex -c windows.sandbox="elevated" sandbox -P <档名> -C <副本目录> -- <命令…>
```

`<专用 CODEX_HOME>\config.toml`：

```toml
[permissions.ixaeon]
[permissions.ixaeon.workspace_roots]
"<副本目录>" = true
[permissions.ixaeon.filesystem]
":root" = "read"            # 不带这一条：elevated Windows sandbox requires effective `:root` read access
"<副本目录>/**" = "write"
[permissions.ixaeon.network]
enabled = false
[shell_environment_policy]
inherit = "all"

[windows]
sandbox = "elevated"        # 不带这一段就退回旧路，报 Restricted read-only access …
```

沙箱里跑 vitest 的额外一条：把 `TEMP`/`TMP` 指到副本里的可写目录（`<副本>\tmp`），否则 vite 建临时目录被拒。

### Claude Code

```
claude -p "<这一棒的交代>" --output-format json          # 续上一轮：再加 --resume <session_id>
```

写文件这一条**这次没能补**（额度），按 L0 的结论：`-p` 模式不给权限就写不了。L0b 想试的白名单（`--allowedTools` / `--permission-mode`）留给下一次。

### DSH

```
dsh --profile headless --json "<这一棒的交代>"            # 续上一轮：--session-id <sessionId>
```

- headless profile 的凭据插件是 `disabled: true`（`dsh --profile headless --dump-config` 里 `- id: credentials / name: '@deepseek-ai/dsh-credentials-local' / disabled: true`；web profile 里它是开着的）→ 后台跑拿不到本机凭据库里的 key，报 `MISSING_CREDENTIAL`。
- 要能跑，二选一：启动环境里给 `DEEPSEEK_API_KEY`（插件自己也写了 `apiKeyEnv: DEEPSEEK_API_KEY`），或者把 headless profile 的凭据插件打开。**这两件都要用户拍板，我没有改任何配置。**
- 关在一个目录里（设置上有）：`DSH_PERMISSION_MODE` 或 profile 里 `sandbox-policy` 的 `mode`；默认就是 `workspace-write` + `workspaceRoot = 当前目录`，审批 `ask`。**不需要**用 `danger-full-access`（规格也不许）。

## 真机通过（原样输出，已遮掉临时目录/用户目录/账户名）

### 丁-1：那一次提权

```
== 1) 提权之前（只读）
   服务 CodexSandboxService.OpenAI.Codex：RUNNING
   本地账户里的 sandbox 相关名字：CodexSandboxOffline、CodexSandboxOnline
   带 Codex 的服务条目：SERVICE_NAME: CodexSandboxService.OpenAI.Codex
   防火墙里带 Codex 的规则：33 条
   ~/.codex/.sandbox-bin：33 个文件；最新两个：codex.exe (324591408 bytes)、codex-command-runner-0.154.0-alpha.6.2.exe (8218928 bytes)
== 2) 先确认参数形状（不带 --elevated，不会动机器）
   exit=1｜Error: `codex sandbox setup` currently requires --elevated
== 3) 提权一次：codex sandbox setup --elevated --current-user --codex-home <home-A>
   PowerShell 结果：RESULT=EXITED EXITCODE=0
   setup 自己的输出（原样，遮罩后）：
     Windows elevated sandbox setup completed for <本机账户> at <本机>\ixa-l0b-scratch\home-A.
== 4) 提权之后（只读）
   服务 CodexSandboxService.OpenAI.Codex：RUNNING
   本地账户里的 sandbox 相关名字：CodexSandboxOffline、CodexSandboxOnline
   带 Codex 的服务条目：SERVICE_NAME: CodexSandboxService.OpenAI.Codex
   防火墙里带 Codex 的规则：34 条
   ~/.codex/.sandbox-bin：33 个文件（没变）
   对比：服务 RUNNING → RUNNING｜账户 「CodexSandboxOffline、CodexSandboxOnline」→「CodexSandboxOffline、CodexSandboxOnline」
   对比：防火墙 Codex 规则 33 条 → 34 条｜带 Codex 的服务条目 1 → 1
== 5) 装完之后，沙箱起不起得来（带提权设置，空命令，不调模型）
   exit=1｜0.09s｜windows sandbox failed: elevated Windows sandbox requires effective `:root` read access
```

（第 5 步那一条是**profile 少写了 `:root` 读权限**，不是提权没成；补上之后见下面第 5 步重跑。）

### 丁-2：装完之后要不要每次提权

```
== 5) 装完之后，沙箱起不起得来（带提权设置，空命令，不调模型）
   exit=0｜0.95s｜(没有错误行)
   stdout：l0b-ok
== 6) 同一个 CODEX_HOME 连跑 10 次（带提权设置）——弹不弹窗、成不成、用时
   #1 exit=0｜1.08s｜没有错误行，stdout=l0b-ok
   #2 exit=0｜1.16s｜没有错误行，stdout=l0b-ok
   #3 exit=0｜1.15s｜没有错误行，stdout=l0b-ok
   #4 exit=0｜1.16s｜没有错误行，stdout=l0b-ok
   #5 exit=0｜1.1s｜没有错误行，stdout=l0b-ok
   #6 exit=0｜1.15s｜没有错误行，stdout=l0b-ok
   #7 exit=0｜1.15s｜没有错误行，stdout=l0b-ok
   #8 exit=0｜1.31s｜没有错误行，stdout=l0b-ok
   #9 exit=0｜1.34s｜没有错误行，stdout=l0b-ok
   #10 exit=0｜1.56s｜没有错误行，stdout=l0b-ok
   10 次总用时 12.2s
== 7) 同一个 CODEX_HOME 连跑 10 次（不带提权设置，看默认走哪条路）
   #1..#10 全部：exit=1｜0.1–0.28s｜windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend
   10 次总用时 1.3s
== 8) 换一个新的 CODEX_HOME（home-B），跑一次（带提权设置）
   exit=1｜122.86s｜windows sandbox failed: orchestrator_helper_launch_canceled: ShellExecuteExW failed to launch setup helper: 1223
== 9) 小结
   带提权设置：10/10 成功，中位 1.15s（1.08–1.56s）
   不带提权设置：0/10 成功，中位 0.11s（0.1–0.28s）
   超过 5 秒的调用（有弹窗/卡住的样子）：0 次
   新 CODEX_HOME（home-B）第一次：exit=1
```

第一次跑（profile 里还没有 `:root`）失败、补上之后成功，中间那段提权装了什么的取证：

```
[2026-10-20T15:19:59.350199200+00:00] ensuring sandbox users offline=CodexSandboxOffline online=CodexSandboxOnline
[2026-10-20T15:19:59.772183100+00:00] firewall rule configured name=codex_sandbox_offline_block_loopback_udp …
[2026-10-20T15:20:00.092875700+00:00] firewall rule configured name=codex_sandbox_offline_block_loopback_tcp …
[2026-10-20T15:20:00.453615200+00:00] firewall rule configured name=codex_sandbox_offline_block_loopback_tcp … RemotePorts=1-65535 …
[2026-10-20T15:20:00.779651800+00:00] firewall rule configured name=codex_sandbox_offline_block_outbound …
[2026-10-20T15:20:01.101966+00:00] firewall rule configured name=codex_sandbox_offline_block_inbound …
[2026-10-20T15:20:01.118624200+00:00] WFP setup succeeded for CodexSandboxOffline with 12 installed filters
[2026-10-20 23:20:01.122 codex-windows-sandbox-setup.exe] setup provisioning binary completed
```

装完之后那个专用 CODEX_HOME 里多了这些东西（对应 D2c 说「旧四样已经不够用了」）：

```
.sandbox/（deny_read_acl_state.json、sandbox-<id>.log、sandbox.2026-10-20.log、setup_marker.json）
.sandbox-bin/codex-command-runner-0.163.0-alpha.10.2.exe
.sandbox-secrets/sandbox_users.json
cap_sid
```

### 丁-3：沙箱里能干什么（同一份探测脚本，沙箱里 / 沙箱外各跑一次）

```
== A) 沙箱里跑（带提权设置，不提权、不弹 UAC、不调模型）
   exit=0｜整条命令用时 1.96s
   [沙箱里] 副本里写文件（应当成）：写成了 → <本机>\ixa-l0b-scratch\caps-copy\inside.txt
   [沙箱里] 往副本外写文件：被拒（EPERM）
   [沙箱里] 经目录链接往真实依赖写：被拒（EPERM）
   [沙箱里] 连本机端口 57438：连上了
   [沙箱里] 连外网 1.1.1.1:443：被拒（EACCES）
   [沙箱里] 固定 CPU 活（600 万次循环）：8ms（acc=true）
   [沙箱里] 跑 vitest 的退出码：1
   [沙箱里]   vitest｜Test Files  1 failed (1)
   [沙箱里]   vitest｜Error: EPERM: operation not permitted, mkdir '<本机>\LekV-3Bxy-dqCaYuNGBpI\ssr'
== B) 同样的脚本在沙箱外跑一遍（对照）
   exit=0｜整条命令用时 0.91s
   [外面] 副本里写文件：写成了
   [外面] 往副本外写文件：写成了 → <本机>\ixa-l0b-scratch\caps-outside\hit-outside.txt
   [外面] 连本机端口 57438：连上了
   [外面] 连外网 1.1.1.1:443：连上了
   [外面] 固定 CPU 活（600 万次循环）：10ms
   [外面] 跑 vitest 的退出码：0（1 passed）
== C) 落盘取证（沙箱里那次写没写出来）
   存在（20 bytes）｜<本机>\ixa-l0b-scratch\caps-copy\inside.txt
   不存在｜<本机>\ixa-l0b-scratch\caps-outside\hit.txt
   不存在｜<工作目录>\node_modules\__l0b_probe.txt
```

把 `TEMP`/`TMP` 指到副本里之后再跑同一套：

```
== A) 沙箱里跑（带提权设置，不提权、不弹 UAC、不调模型）
   exit=0｜整条命令用时 2.19s
   [沙箱里] 往副本外写文件：被拒（EPERM）
   [沙箱里] 经目录链接往真实依赖写：被拒（EPERM）
   [沙箱里] 连外网 1.1.1.1:443：被拒（EACCES）
   [沙箱里] 跑 vitest 的退出码：0
   [沙箱里]   vitest｜RUN  v4.1.11 <本机>/ixa-l0b-scratch/caps-copy
   [沙箱里]   vitest｜✓ synth.test.js (1 test) 3ms
   [沙箱里]   vitest｜Test Files  1 passed (1)
   [沙箱里]   vitest｜Tests  1 passed (1)
== D) 小结
   沙箱里那次：exit=0、用时 2.19s，其中 vitest 退出码 0
   沙箱外那次：exit=0、用时 0.92s，其中 vitest 退出码 0
```

### 丁-4：默认配置目录 + `.sandbox-bin`

```
== 用哪个 codex：0.163.0-alpha.10.2
== 跑 codex exec -s workspace-write（默认配置目录，一次真调用）
   exit=0｜用时 23.2s
   和 .sandbox-bin 加锁有关的行：
     （没有）
   最后两条 JSON 事件：
     {"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"OK"}}
     {"type":"turn.completed","usage":{"input_tokens":23306,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":32,"reasoning_output_tokens":25}}
RESULT 这次成功了：L0 报过的「.sandbox-bin 加锁失败」这次没出现
```

### 丙：Codex 按会话号续

```
== 第一次：让它记住一个合成的词
== exec（第一次）：exit=0｜用时 17.9s
   {"type":"thread.started","thread_id":"01a159f8-4a1d-7f80-b3bf-d5982e401933"}
   模型说的话："OK"
   拿到的会话号：01a159f8-4a1d-7f80-b3bf-d5982e401933
   第一次输出里的 JSON 事件类型：thread.started / item.completed / error / turn.started / agent_message / turn.completed
== 第二次：按会话号续，问它那个词
== exec resume <thread_id>（第二次）：exit=0｜用时 23.7s
   {"type":"thread.started","thread_id":"01a159f8-4a1d-7f80-b3bf-d5982e401933"}
   模型说的话："zq7k"
RESULT 通过：按会话号续的那次记得第一次给的那个词（zq7k）
```

（两次都带着同一条噪音：用户 `~/.codex/config.toml` 里有 5 项不认识的设置、hooks 有两份表示。只看没改。）

### 甲：DSH

```
== DSH：exit=1｜用时 1.6s
   [stderr]
   dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment
   JSON 事件 6 条，最后 6 条：
     {"type":"session","sessionId":"session-24f1c7e0-9527-4fc2-a05f-0fa01623bb12","cwd":"<本机>\\ixa-l0b-dsh-HYdcbr\\work"}
     {"type":"status","phase":"turn_start","turn":1}
     {"type":"status","phase":"step_start","turn":1,"step":1}
     {"type":"status","phase":"step_end","turn":1,"step":1}
     {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"… MISSING_CREDENTIAL"}}}
     {"type":"final","text":""}
== ~/.dsh 下变了 / 新增 / 少了什么（只比时间与大小）
   变了 1 个：<本机>\.dsh\profiles\headless\cordis.yml → 1792510638405/223
```

原因（只看键名，没看任何值）：

```
=== headless：credentials 那一段 ===
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  disabled: true
=== web：credentials 那一段 ===
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
```

凭据文件在（`~/.dsh/.credentials.yaml`，只列了键名：`refs` 下有 `DEEPSEEK_API_KEY` 等 7 个名字、`records` 有三条），所以不是「用户没配」，是 headless 这条路根本没挂那个插件。

### 乙：Claude（额度用尽的原样输出）

```
{"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"5ea9e82e-…","total_cost_usd":0,
 "usage":{…全部 0…},"permission_denials":[],"terminal_reason":"api_error","is_error":true,
 "api_error_status":429,"api_error_origin":"first_party","api_error":"usage_limit_reached",
 "result":"You've hit your session limit · resets 3:10am (Asia/Shanghai)","type":"result"}
```

并发的第四次调用（DSH 与 Claude 同时起）也是这个结果：DSH 因凭据退 1，Claude 因额度退 1。

## 自动化通过

- `node scripts/verify.mjs` 全绿（见下）；新增脚本过 prettier/eslint。
- 新增的真机脚本（都在 `scripts/real/`，可复现）：
  - `l0b-codex-elevate.mjs`（**开头写明会弹一次管理员确认**；`--after-setup` 跳过提权只补观察、`--no-elevate` 只做只读观察）
  - `l0b-codex-sandbox-caps.mjs`（沙箱里外对照的能力探测，不提权、不调模型）
  - `l0b-codex-default-home.mjs`（默认配置目录那一条，1 次真调用）
  - `l0b-codex-resume.mjs`（丙，2 次真调用）
  - `l0b-dsh-probe.mjs`（甲，`--probe help|tiny|write-inside|write-outside|resume|concurrent`）

## 真调用次数（规格上限：DSH/Claude 各 8、Codex 4）

| 命令行 | 用了几次 | 说明                                                                 |
| ------ | -------- | -------------------------------------------------------------------- |
| Codex  | **3**    | 丁-4 默认目录 1 次 + 丙 2 次；`codex sandbox` 那些不调模型，不算     |
| DSH    | **2**    | tiny 1 次 + 并发 1 次，两次都卡在 `MISSING_CREDENTIAL`，没有继续浪费 |
| Claude | **2**    | 并发 1 次 + 查额度 1 次，两次都是 429、`total_cost_usd` 0，没有花钱  |

## 已知缺口

1. **乙整条没做**：Claude 会话额度用尽（429，3:10 重置）。`--allowedTools` / `--permission-mode` 的白名单没试过；「命令行上的白名单」还是「项目里的设置文件」哪个稳，没有答案。
2. **甲只有设置层的答案，没有实测**：headless 调不动，所以「目录里建文件 / 往目录外建 / 按会话号续」三条都没有数据。要不要给 headless 挂凭据插件、或者用环境变量给 key，由用户/整合方定。
3. **`~/.codex` 里的 5 项不认识的设置和重复 hooks**：只记录，没改（那是用户的配置）。
4. **`.sandbox-bin` 现在有 33 个历史 helper**（最老 2026-04-18）：没清理，也没跑 `codex sandbox uninstall`（规格不许）。
5. **提权的边界只验到「每个 CODEX_HOME 一次」**：没有试「一个 HOME 装过之后，另一台机器/另一个用户怎么样」，也没试把同一个 HOME 复制一份算不算装过。
6. **本机端口连得上**：沙箱里连 `127.0.0.1:<本机监听端口>` 成功了，连外网 443 被拒。也就是说「连不出去」这条对**外网**成立，对**本机其它进程**不成立——如果哪一步是靠「沙箱里连不上本机服务」来保证的，要重新想。没有继续往深里挖（那要动应用的沙箱档位）。
7. **丁-4 只证明启动阶段不报错**：那次 `codex exec` 只回了一句话、没有真的跑命令，所以「`.sandbox-bin` 加锁失败不报了」这句只在启动路径上成立，沙箱内执行没走。
8. **一次提权是用户在对话里点的「好」**；用户没有在真机上「接受」这份交付（见下）。

## 用户接受

未发生。这一次提权是用户在对话里明确同意的（「好，可以提权（推荐）」），机器上只多了 1 条防火墙规则；除此之外没有改任何设置。
