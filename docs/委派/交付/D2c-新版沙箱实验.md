# D2c 新版 Codex 沙箱实验 交付

- 分支：`dev/D2c`；档位 **B**（碰系统里的沙箱，只交实验脚本和结论，不改应用）
- 规格：[D2c-新版Codex沙箱实验](../D2c-新版Codex沙箱实验.md)
- 版号：本机最新版 **`codex-cli 0.163.0-alpha.10.2`**（`%LOCALAPPDATA%\OpenAI\Codex\bin\896a0166b774037a\codex.exe`；另一份是 `0.130.0-alpha.5`）

**一句话结论：新版 0.163 的 `codex sandbox` 在「不提权」的前提下**根本跑不起来**——不管 profile 怎么写，每次都是同一条**
`windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend`（exit 1、中位 0.06–0.09s（每次实测略有不同）、不弹窗、不改机器状态）。
所以 9 个问题里「沙箱里跑 vitest / 联网挡不挡 / 往外写挡不挡」三件没有数据——**按规格停在这里，要不要试提权由用户定**。

## 已实现（这一单做了什么）

- 新增实验脚本 `scripts/real/d2c-sandbox-experiment.mjs`（跑法：`node scripts/real/d2c-sandbox-experiment.mjs`）：找最新版、抓 `sandbox --help`、三种 profile 各跑一次、非 %TEMP% 的 CODEX_HOME 跑一次、参数错误一次、连跑 10 次、被动查机器状态；输出遮掉临时目录/用户目录/账户名，`RESULT` 与退出码一致。
- 硬规矩逐条守住：**每次调用都设了 `CODEX_HOME`**（一次性目录）；**没碰用户的 `~/.codex`**；**没提权**（没有 `elevated`）；**没跑 `codex sandbox uninstall`**；**没调模型、没跑 `codex exec`**；全是合成内容与一次性目录。

## 九个问题的答案

| # | 问题 | 答案 |
| --- | --- | --- |
| 1 | 怎么调 | argv 形状：`codex sandbox --permission-profile <PROFILE> -C <副本目录> -- <命令…>`（`-P` 现在是**必填**，不给就报 `error: the following required arguments were not provided: --permission-profile <NAME>`；`windows` 子命令没了）。旧版的 `config.toml` 形状**仍然被接受**（`[permissions.<名字>]` + `workspace_roots` + `filesystem` + `network` + `shell_environment_policy` + `default_permissions`），但 `filesystem` 的通配规则严了：`"*"` 只许配 `deny`，写权限要精确路径或以 `/**` 结尾（`Error: filesystem glob path \`*\` only supports \`deny\` access`） |
| 2 | 要不要授权 | **要**。不提权时三种 profile 形状全部失败（同一条提权错误、exit 1）；连跑 10 次也全是这一条。不提权时**不会往机器上装东西**：本机服务状态与旧版那两个账户跑前跑后一致，只在自己的 CODEX_HOME 里写 `.sandbox/sandbox.<日期>.log`（以及 CODEX_HOME 不在 %TEMP% 时多写几个 `tmp/arg0-windows/…` 辅助文件） |
| 3 | vitest 跑不跑得起来 | **没测**：沙箱起不来，没有「沙箱里」这一侧的数据 |
| 4 | 联网挡不挡得住 | **没测**，因此「挡不挡得住」没有答案。规格要的两种开关（`network.enabled=false`、`--sandbox-state-disable-network`）都写进去了，但沙箱没启动，谈不上拦没拦 |
| 5 | 往外写挡不挡得住 | **没测**，同上（副本外没写、目录链接写不穿这两条都没数据） |
| 6 | 有没有不弹窗、不写东西的检查办法 | 能被动查到：版本与路径（`--version`）、Windows 服务 `CodexSandboxService.OpenAI.Codex` 在不在跑（`sc query`）、旧版建的两个本地账户在不在（`net user`）。**但这几样已经不够说明「新版能用」**：本机服务是 `RUNNING`、`CodexSandboxOffline`/`CodexSandboxOnline` 都在，新版照样要求提权。这次实验里也没见到旧检查用的 `cap_sid`、`.sandbox-bin` helper、`setup_marker.json` 被创建 |
| 7 | 无人值守 | 同一个配方连跑 10 次：**10/10 都是同一条提权错误、exit 1、全程不弹窗**（每次都在 1 秒内返回），用时 0.07–0.09s。也就是说「不提权的失败」是确定性的、可无人值守的；但**成功的那条路没验** |
| 8 | 开销 | 失败调用中位 **0.06–0.09s**（三次实测：0.06 / 0.07 / 0.09，随机器负载波动；下面 RESULT 行里是当次的值）。沙箱里真实执行的开销**测不了**（沙箱没启动） |
| 9 | 结论落到哪 | 见下面「给 D2 / V4 的建议」（只写建议，没改代码） |

## 配方（路径用占位）

**新版 argv（不提权时也会走到同一条错误，但参数形状是对的）**：

```
<codex.exe> sandbox --permission-profile ixaeon -C <副本目录> -- <命令…>
```

**profile 的 `config.toml`（放在 `<专用 CODEX_HOME>\config.toml`）**——旧版那套仍然解析得通：

```
[permissions.ixaeon]
[permissions.ixaeon.workspace_roots]
"<副本目录>" = true
[permissions.ixaeon.filesystem]
"<副本目录>/**" = "write"
[permissions.ixaeon.network]
enabled = false
[shell_environment_policy]
inherit = "all"

[permissions.default_permissions]
extends = "ixaeon"
```

**但要用它跑起来，必须先有一次提权**（新版报的原话是「restricted read-only access 需要 elevated Windows sandbox backend」）。这条我没有试：规格写「不提权就挡不住的，如实写、停在这里，要不要试提权由用户定」。**请用户定：要不要我跑一次提权（会弹一次 UAC）把 3/4/5 三问补齐。**

**另有一条和「CODEX_HOME 用临时目录」冲突的事实**：新版拒绝在 **%TEMP%** 下创建 helper（`WARNING: … Refusing to create helper binaries under temporary dir "<本机>\\"`），会继续但少建 PATH 别名与辅助文件。我把 CODEX_HOME 放到 `%TEMP%` 之外的**一次性目录**试了一次：告警没有了、helper 生成了，**但提权错误照旧**——所以「临时目录」不是拦路的原因，提权才是。

## 给 D2 / V4 的建议（只写建议，不改代码）

- **D2 的调用**（`executor.ts` 依赖档派生、`verifySandbox.ts`）：新版必须去掉 `sandbox windows` 子命令，改成 `sandbox --permission-profile <名字> -C <副本> --`；`-P` 是必填。其余形状（专用 CODEX_HOME、副本目录、`filesystem` 写根、`network.enabled=false`）可以照旧。
- **检查口径**：旧的四样（`cap_sid` / 版本配对的 helper / `setup_marker.json` / 服务 RUNNING）**不能再当「授权有效」的依据**——本机这四样里服务和账户都在、新版仍然要提权。建议改成「用一个空命令真跑一次 `codex sandbox`，看退出码」作为授权探测；它 0.07s 就返回、不弹窗、不改机器状态，适合无人值守。
- **V4 设置页**：「授权」按钮**仍然必要**（新版必须提权一次），但文案要改：现在写的是「授权一次就行；Codex 升级之后要再授权一次」——新版升级后要重新授权这点没变，但「装 helper / 四样检查」这套描述要按新版重写。
- **依赖档隔离的路线**：不改提权的话，新版沙箱在这台机器上等于不可用。要么接受「一次性提权 setup + 之后派生不提权」（这点**没验过**：不知道新版是每次都要提权，还是 setup 一次就够），要么换隔离手段（容器/WSL/单独 Windows 沙箱）。要不要试提权、试哪条，请用户定。

## 自动化通过

- `node scripts/verify.mjs`：**全绿，exit 0**（32 步，末尾「全部通过（IXAEON v0.2 验证完成）」）。第一次跑时 `review-recheck-ui` 的 BUI01 报 `Test timeout of 30000ms exceeded`、整步 68.0s 失败，紧接着重跑一遍全绿——慢机上的偶发，与本分支改动无关（本分支只加了一个 scripts/real 脚本和这份说明）。
- 实验脚本本身：`prettier --check`、`eslint` 都过；跑一遍 exit 0、`RESULT 通过`（原样输出在下面）。

## 真机通过（原样输出）

跑法：`node scripts/real/d2c-sandbox-experiment.mjs`（输出已遮掉本机账户名与临时目录）：

```
== 1) bin 下的 codex.exe 与版本 ==
   - <本机>\AppData\Local\OpenAI\Codex\bin\896a0166b774037a\codex.exe → codex-cli 0.163.0-alpha.10.2
   - <本机>\AppData\Local\OpenAI\Codex\bin\codex.exe → codex-cli 0.130.0-alpha.5
最新：0.163.0-alpha.10.2

== 2) codex sandbox --help（原样，遮罩后） ==
Run commands within a Codex-provided sandbox

Usage: codex sandbox [OPTIONS] [COMMAND]... [COMMAND]

Commands:
  uninstall  Remove the legacy Windows sandbox's machine-wide accounts and network rules
  help       Print this message or the help of the given subcommand(s)

Arguments:
  [COMMAND]...
          Full command args to run under Windows restricted token sandbox

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.
          
          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --sandbox-state-json <JSON>
          Opaque JSON value from `codex/sandbox-state` to apply directly

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --sandbox-state-readable-root <SANDBOX_STATE_READABLE_ROOT>
          Add a readable root to the supplied sandbox state. Repeat for multiple roots

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --sandbox-state-disable-network
          Disable direct network access in the supplied sandbox state

  -P, --permission-profile <NAME>
          Named permissions profile to apply from the active configuration stack

  -p, --profile <CONFIG_PROFILE>
          Layer $CODEX_HOME/<name>.config.toml on top of the base user config

  -C, --cd <DIR>
          Working directory used for profile resolution and command execution

      --include-managed-config
          Include managed requirements while resolving an explicit permissions profile

  -h, --help
          Print help (see a summary with '-h')
WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "<本机>\\" (codex_home: AbsolutePathBuf("<本机>\\ixa-d2c-help-ynCP9m"))

== 3) 不提权跑 codex sandbox（三种 profile 形状） ==
   - 旧版那套（workspace_roots + copy/** write + network false）：exit=1，windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend
     CODEX_HOME 里留下 3 项
   - 只有空 profile（[permissions.ixaeon]）：exit=1，windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend
     CODEX_HOME 里留下 3 项
   - copy/** 写 + 一条 deny：exit=1，windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend
     CODEX_HOME 里留下 3 项

== 4) CODEX_HOME 放在 %TEMP% 之外（一次性目录）==
   exit=1，windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend
   「不允许在临时目录下建 helper」的告警：没有（helper 能生成）
   home 里留下（前 8 项）：.sandbox/、.sandbox/sandbox.2026-10-20.log (65 bytes)、config.toml (308 bytes)、tmp/、tmp/arg0-windows/、tmp/arg0-windows/codex-arg0GZx6FC/、tmp/arg0-windows/codex-arg0GZx6FC/.lock (0 bytes)、tmp/arg0-windows/codex-arg0GZx6FC/applypatch.bat (115 bytes)

== 5) 少给 -P 时 CODEX_HOME 里有什么（cap_sid 还算不算授权标记） ==
   exit=2；文件：config.toml (320 bytes)
   → 这次没出现 cap_sid

== 6) 连着跑 10 次（确定性 / 弹窗 / 耗时） ==
   退出码：1,1,1,1,1,1,1,1,1,1
   每次都是同一条提权错误：是
   用时（秒）：0.09,0.1,0.09,0.09,0.09,0.09,0.09,0.09,0.09,0.08｜中位 0.09s
   全程没有弹窗：每次都在 1 秒内返回（有弹窗会卡住到超时）

== 7) 被动机器状态（只读查询：sc query / net user） ==
   服务 CodexSandboxService.OpenAI.Codex：RUNNING
   本地账户里的 sandbox 相关名字：CodexSandboxOffline、CodexSandboxOnline
   跑一次失败之后：服务 RUNNING、账户 CodexSandboxOffline、CodexSandboxOnline

RESULT 通过：新版 0.163 的 codex sandbox 在**不提权**时一律以「Restricted read-only access requires the elevated Windows sandbox backend」失败（exit 1、中位 0.09s、不弹窗、不改机器状态）；配方与结论见交付说明
```

## 已知缺口

1. **3、4、5 三问没有数据**：沙箱在不提权时起不来（原因见上）。要补必须提权一次，等用户定。
2. **7 只验了「失败路径的确定性」**：10 次都是同一条错误；「成功路径连跑 10 次不弹窗」没验。
3. **8 只量了失败调用的开销**（0.06–0.09s 中位，随机器负载波动），沙箱内真实执行的用时没有。
4. **「一次提权之后能不能免提权地派生」没验**：这一点决定 D2 的无人值守方案，是这一单最关键的未知，但不提权验不了。
5. 本机已有旧版留下的服务与两个本地账户（`CodexSandboxOffline`/`CodexSandboxOnline`，V4/D2b 那次授权建的），这次实验**没有改它们**；新版要不要清理/重建它们，也属于提权才知道的事。

## 用户接受

未发生。
