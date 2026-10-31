# DG1 接力的 DSH 网关跟桌面版走 交付

- 分支：`dev/DG1`，基于 main `0d60bd0`；档位 **B**（本周例外：测试和实现一起在分支上，状态改「待复审（整合方）」，不合并）
- 执行方：dev

## 已实现

接力每一棒起 DSH 之前，从 DSH 桌面版配置里**只取顶层 `- id: llm-pi-ai` 那一项**，写进一次性临时补丁，
插到 DSH 参数里接力补丁的前面：`--profile headless --patch <临时网关补丁> --patch <接力补丁> …`。
棒结束（正常、替身崩溃、被超时强杀三种）都删掉临时文件；内容不打印、不记录。桌面版配置不存在或
没有这一项时照原来的参数起，并打一行「没找到 DSH 桌面版的网关配置，接力用自己补丁里的」。

改动文件与行数（`git diff --stat`，新文件用 `git add -N` 后统计）：

```
 packages/relay/README.md                           |   1 +
 packages/relay/src/gateway.ts                      | 100 +++++
 packages/relay/src/index.ts                        |   9 +
 packages/relay/src/run-turn.ts                     |  70 ++--
 .../test/acceptance/dg1-desktop-gateway.test.ts    | 414 +++++++++++++++++++++
 scripts/real/dg1-desktop-gateways.mjs              | 141 +++++++
 6 files changed, 711 insertions(+), 24 deletions(-)
```

源码改动（`packages/relay/src`）共 179 行，没超过 300 行。上面统计不含本交付说明
（`docs/委派/交付/DG1.md`，文档不计入源码行数）。

和规格不一样的地方，逐条写清楚：

1. **实现放在 `run-turn.ts`，不是 `dsh.mjs`。** 规格写的是「在 `packages/relay/bin/dsh.mjs` 或起棒拼参数的地方」。
   超时那一刀是 `run-turn.ts` 里 `taskkill /T /F` 杀启动器那一棵进程树——启动器自己的 `finally` 跑不到，
   临时文件就留在系统临时目录里（条件 2 要求超时后也不在）。`run-turn.ts` 是杀完进程之后仍然活着的调起方，
   它的 `finally` 一定会跑，所以临时补丁的建立与删除都放在这里。取段、插参数、删文件的纯函数在
   `src/gateway.ts`。
2. **`README.md` 改了；接力补丁开头的注释没改。** 用户本机的 `~/.dsh/ixaeon-relay.patch.yml` 不在仓库里，
   规格的约束也写了「不改用户的接力补丁」，所以那句注释（以及删旧网关副本）留给用户 / 整合方经用户同意后做。
   这次只把 README 第 3 条改成「网关在 DSH 桌面版里管，接力每棒自动取」。
3. **没有 `acceptance.mjs lock`。** B 档的锁定是整合方的关卡（AGENTS.md），这一棒只把测试文件放在分支上；
   所以 `acceptance.mjs run DG1` 现在找不到这个任务，用 vitest 直接跑（见下）。

## 验收测试（v2 规格任务）

`packages/relay/test/acceptance/dg1-desktop-gateway.test.ts`，8 条测试逐条对应规格的条件：

- 条件 1：合成桌面版三项（`ui-settings-general`、`llm-pi-ai`（两个网关，其中 `magpie`）、`mcp-servers`）
  → 替身 DSH 收到的参数是 `--profile headless --patch <A> --patch <接力补丁> --json …`；A 在系统临时目录、
  内容逐字等于 `llm-pi-ai` 那一项，没有 `ui-settings-general` / `mcp-servers` / `chrome-devtools`。
- 条件 2：正常、替身崩溃（退出码 7）、超时（`timeoutMs` 1500、真被 taskkill 杀掉）三种结束后 A 都不在。
- 条件 3：桌面版配置不存在、以及存在但没有 `llm-pi-ai` 项 → 参数与现在逐项相等（只有一个 `--patch`），
  输出那一行提示。
- 条件 4：`DSH_HOME` 指向另一份配置、默认家目录里放一份带 `wrong-gateway` 的 → 取到的是 `DSH_HOME` 那份。
- 条件 5：用真调度器（合成 origin / 队列 / 数据目录）跑一棒，再把北京时间 21:10 的日报发到本机假飞书
  webhook：`ledger.jsonl`、`turns/1/` 里的 stdout/stderr、数据目录里每个文件、调度器输出、飞书请求体里
  都找不到合成网关地址与 `apiKeyEnv` 的值。

## 自动化通过

- 直接跑这份验收测试（B 档未锁定，`acceptance.mjs run DG1` 还没有登记）：
  `node node_modules/vitest/vitest.mjs run --project acceptance packages/relay/test/acceptance/dg1-desktop-gateway.test.ts`
  → `Test Files 1 passed (1)`、`Tests 8 passed (8)`（日志 `.logs/dg1-test-4.log`）。
- `node scripts/verify.mjs`：**全过，退出码 0**（日志 `.logs/verify-dg1.log`）。各步：lint、format:check、
  local-user（1071 个跟踪文件里没有本机账户名）、typecheck、typecheck-acceptance、build 全 ✓；
  unit 13 个文件 69 条 ✓；integration 83 个文件 483 条通过、17 条跳过（原有跳过）；
  acceptance-lock 90 个任务的 177 个锁定验收测试都没被改 ✓；acceptance 166 个文件 1288 条 ✓；
  各套 review 与真实 Electron 界面复审全 ✓。
- GitHub 上的 verify：**本棒看不到**。接力指令写明「这一棒的推送由调度器替你做」，分支要等本棒结束后由调度器推上去。

## 真机通过

`node scripts/real/dg1-desktop-gateways.mjs`（用用户真实的桌面版配置，只读；挑一个桌面版登记、接力补丁里
没有的网关模型，临时把默认模型指过去，起一次真 DSH headless，只问「只回复两个字母：OK」；输出里没有配置内容）：

```
退出码：0
含 OK 的那一行：{"type":"final","text":"OK"}
```

这证明只带 `llm-pi-ai` 网关段时，桌面版里新加的网关模型能答话（替身测试证明 MCP 段没带进来）。

## Codex 审查（A 档）

B 档不做 Codex 审查，等整合方复审。

## 已知缺口

- 接力补丁开头那句注释、删掉接力补丁里旧的网关副本：都在用户的 `~/.dsh/ixaeon-relay.patch.yml` 里，
  按约束没动；留给用户 / 整合方经用户同意后做。删掉副本之前，接力补丁里的旧副本仍然会和桌面版段叠加，
  旧副本里没变的网关继续生效；新加的网关已经能看到。
- 取段是按顶层行切口（顶格 `- id:` 到下一个顶格 `- id:` 之前）。DSH 自己写出来的桌面版配置是缩进的，
  正常情况没问题；要是以后有人手工把嵌套项也改成顶格，切口会提前。没有引入 YAML 库（仓库里没有这个依赖，
  K10a 的规格也写的按行认），只按规格给的边界取。
- 真机检查每次会真的请求一次网关、花一点额度；桌面版里要是所有模型接力补丁里都有了，脚本会打印
  「没有接力补丁里不存在的网关模型」并退出 1——那是如实说这一项证明不了，不是回归。
- 这一单只让 DSH 用上网关段；应用自己的多网关（MP1）和 K10a 的模型下拉框不在这一单里。

## 用户接受

未发生（用户用过并认可之后才写）。