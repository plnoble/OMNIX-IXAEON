# 委派单 L20：`relay init` 生成的开发命令带上 DSH 补丁

档位：**A**（只改调度器生成配置的那一处；不放开权限、没有新的外发，补丁文件本身用户早就在用）。大小：小（约 20 行源码）。依赖：无。来源：接力第 35 棒（规划棒），[三周任务单](../三周任务单.md)「接下来一周」第 4 件。

## 要什么

`relay init` 生成配置时，用户本机有 `~/.dsh/ixaeon-relay.patch.yml` 就在开发的命令里 `--profile headless` 后面加上 `--patch <这个文件的绝对路径>`；没有就不加，并在输出里说一句。已经有 `config.json` 时照旧一字不动。

## 为什么

- 10-23 用户定了：接力的 DSH 用完全权限、plan 用百度千帆的 token plan，都写在 `~/.dsh/ixaeon-relay.patch.yml`，调度器起 DSH 时用 `--patch` 带上（三周任务单 10-23 晚那一段）。
- 现在 `relay init` 不加这一项（`packages/relay/README.md` 第 29 行原话：「`relay init` 不会替你加这一项，重新生成配置后要补上」）。重新生成配置后忘了补，DSH 会走 headless 默认的 DeepSeek 官方 API、关在沙箱里——装不了依赖、跑不了测试，第 3 棒就是这么停的。

**范围缩小的说明**（整合方写规格时查代码定的）：任务单上这一件还列了 `planPerDay`、`morningReport`、`lanes`、`gitIdentity`。查下来：

- `planPerDay`、`morningReport` 已经在 `config.example.json` 里，`buildConfig`（`packages/relay/bin/relay-main.ts`）照样例生成，**现在就会写进去**，不用改；
- `lanes`、`gitIdentity` 是 L11 的契约第 1 条（「`relay init` 生成的配置写 `lanes: 1`……」），归 L11，这一单不碰；
- L19 的 `weeklyQuotaPatterns` 字样还没见过（L19 规格「为什么」），生成配置里不写。

## 契约（接口写死）

1. 补丁文件的位置：`join(os.homedir(), '.dsh', 'ixaeon-relay.patch.yml')`（Windows 上 `os.homedir()` 读 `USERPROFILE`，测试靠它换成临时目录）。
2. 文件在（`existsSync` 为真）→ 生成的 `roles.developer.argv` 是：
   `['node', '{relay_root}/packages/relay/bin/dsh.mjs', '--profile', 'headless', '--patch', <契约第 1 条的绝对路径>, '--json', '读 {prompt_file}，照里面做。']`
   ——`--patch` 和路径紧跟在 `headless` 后面，其余和现在一字不差。
3. 文件不在 → `argv` 和现在一字不差（不加 `--patch`）。
4. `relay init` 写好配置后的输出多一行（在「写好了」那一行之后）：
   - 带上了：`开发的命令带上了 DSH 补丁：~/.dsh/ixaeon-relay.patch.yml`
   - 没带上：`没找到 ~/.dsh/ixaeon-relay.patch.yml，开发的命令没带 --patch（DSH 会用 headless 默认的设置：DeepSeek 官方 API、关在沙箱里）`
   两句里的路径都**照原样写 `~/`**，不打印展开后的用户目录（AGENTS.md「公开仓库」：输出会被贴进交付说明）。
5. 已经有 `config.json`：照旧只打「已经有配置了，没改：…」，不检查补丁文件、不多打那一行。

## 约束

- 只改 `packages/relay/`：`bin/relay-main.ts` 的 `buildConfig` / `initCommand`，`README.md` 第 29 行那句改成「`relay init` 找得到这个文件就自动加上；生成配置之后才建的这个文件，要自己补」。
- `config.example.json` 不改（L5、L6b 的锁定测试照着它的形状）。
- 已锁定的测试一个字不改。`l5-init`、`l6b-init` 对开发 `argv` 用的是 `toContain`，加两项不会撞红；但这两份测试没换 `USERPROFILE`，跑的机器上有真补丁文件时生成的配置会带上真路径——只写在临时数据目录里，不打印，可以接受。
- 新测试里 `USERPROFILE`（和 `HOME`）都指向临时目录，不读、不碰用户真的 `~/.dsh`。

## 验收

新测试 `packages/relay/test/acceptance/l20-init-patch.test.ts`（照 `l5-init.test.ts` 的搭法：临时 `IXAEON_RELAY_DIR`、`IXAEON_WORKTREES`、`APPDATA`，假 `claude.exe`）：

1. 临时家目录下建了 `.dsh/ixaeon-relay.patch.yml` → 生成的开发 `argv` 与契约第 2 条逐项相等（路径用 `norm` 比）；输出含契约第 4 条「带上了」那句；输出里不出现临时家目录的绝对路径。
2. 临时家目录下没有这个文件 → 开发 `argv` 与契约第 3 条逐项相等；输出含「没带上」那句。
3. `.dsh/ixaeon-relay.patch.yml` 是个**目录**不是文件 → 按 `existsSync` 算在，照第 1 条（写明是规格定的，不额外判断）。
4. 已经有 `config.json`（内容随便写一份）→ 文件内容一个字节不变；输出只有「已经有配置了，没改」，不含契约第 4 条两句里的任何一句。
5. 第 1 条生成的配置 `checkConfig` 放行。

`node scripts/acceptance.mjs lock L20 …` 登记；`node scripts/verify.mjs` 全过；`node scripts/codex-review.mjs L20`；照 AGENTS.md 合并。

## 真机检查

`scripts/real/l20-init-patch.mjs`：临时数据目录、临时工作目录根、临时家目录（`USERPROFILE` 指过去），先不放补丁文件跑一次 `relay init`、再删掉配置、放上补丁文件跑一次；两次各打出开发 `argv` 里有没有 `--patch`、紧跟的是不是那个路径（遮掉临时目录）、输出里那一行原样。任何一步不符打「结论：不通过」退 1；脚本自己出错退出码非零。跑完删临时目录。**不许对用户真的数据目录 `~/.ixaeon/relay` 跑 `relay init`**。
