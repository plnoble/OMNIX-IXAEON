# MG2 整合方、审查、开发都走 magpie（第一支：调度器起角色） 交付

- 分支：`dev/MG2`，基于 main `0fcfd06`；档位 **B**
- 执行方：dev
- 规格：[MG2-角色走magpie轮动.md](../MG2-角色走magpie轮动.md)
- 第二支：[MG2b](MG2b.md)（面板与审查脚本，基于这一支）——按 AGENTS.md 的 300 行规矩拆开：这一支改的是调度器和配置读写，第二支改界面和 `scripts/codex-review.mjs`。

## 已实现

1. **本机 magpie 的清单**：`packages/core/src/cockpit/magpie.ts`——`GET http://127.0.0.1:3425/v1/models`（`Authorization: Bearer magpie`，3 秒超时，不跟跳转），只取每个模型的 `id`（分组就是 `group/<名字>`）；只认本机 `http` + `localhost/127.0.0.1` + 端口。地址沿用 SUB1 的 `cockpit.magpie_url`，没设就用 `http://127.0.0.1:3425`；连不上统一记「没连上 magpie」。
2. **面板能选的项（数据这一层）**：`readRelayModels` 把 magpie 的模型 / 分组并进三行——整合方 `默认 + opus/sonnet/haiku + magpie 清单`，审查 `默认 + magpie 清单`，开发在桌面版网关选项之后加 `magpie / <id>`；连不上时只保留原来的选项并带一句说明。`setRelayModel` 接受 magpie 的值：整合方写 `roles.integrator.magpieModel`、审查写 `review.magpieModel`（空 = 默认），并记下取清单用的本机地址；开发照 K10a 只改接力补丁 `agent-default-model` 的 provider / model 两行。改文件前留 `.bak-<YYYYMMDD-HHmmss>`、原子写入不变。
3. **调度器起整合方**：`run-turn.ts` 见 `roles.integrator.magpieModel` 非空时，照 magpie 的 Claude Code 接法加 `ANTHROPIC_BASE_URL=<本机 magpie>`、`ANTHROPIC_AUTH_TOKEN=magpie`（并去掉用户自己的 `ANTHROPIC_API_KEY`）和参数 `--model <id>`；选「默认」时参数、环境变量和现在逐字一样。
4. IPC `getRelayModels` / `setRelayModel` 每次先取 magpie 清单再读写；没有库（测试里的替身 runtime）不去连本机真实服务。

### 和规格不一样的地方（逐条）

- **按 300 行规矩拆成 MG2 / MG2b**：规格里「面板」「审查脚本」两块的界面与 `codex-review.mjs` 在 MG2b；这一支只做调度器起角色与配置读写。验收条件 1、3 也随第二支交。
- **整合方 / 审查的配置多记一个本机地址**（`roles.integrator.magpieUrl`、`review.magpieUrl`）：规格只写了 `magpieModel`，但起角色时要 `ANTHROPIC_BASE_URL` / Codex 的 `base_url`；地址来自 `cockpit.magpie_url`（可改端口），不在代码里写死。空 = 默认 `127.0.0.1:3425`。
- **整合方的 `默认 / opus / sonnet / haiku` 保留**，magpie 的清单是追加。规格只列「默认 + magpie」；但 K10a 已锁定在 main 的验收测试要求整合方选项正好是那 4 个、而且能选 sonnet，删掉会直接撞红锁定测试。追加既满足 MG2 的「含 magpie 全部模型和分组」，也不改 K10a 的语义。

## 验收测试

B 档本周例外：测试和实现一起在分支上，**测试未锁定**（整合方复审时锁）。`acceptance.mjs run MG2` 还没有登记，下面是直接跑 vitest 的结果。

- `packages/core/test/acceptance/mg2-magpie-models.test.ts`（7 条）
  - 条件 1：合成 magpie 回 `a/m1`、`b/m2`、`group/rot` → 整合方 / 审查 / 开发的选项都含这 3 个（开发写成 `magpie / <id>`），默认仍在；服务关掉 → 只有原来的选项、三行都有「没连上 magpie」。
  - 条件 4：开发选 `magpie / group/rot` → 补丁里 `provider: magpie`、`model: group/rot`，其余字节不变，`.bak-` 备份等于改前；整合方 / 审查选 magpie 的值 → 写进 `magpieModel`，不要 `--model` 进 argv。
  - 条件 5：整合方 / 审查 / 开发传不在清单里的值 → `IXA0012`，补丁和 config 一个字节不变、没有备份。
- `packages/relay/test/acceptance/mg2-integrator-launch.test.ts`（2 条）
  - 条件 2：整合方选 `group/rot` → 替身收到 `--model group/rot`，`ANTHROPIC_BASE_URL` 是 magpie 的首地址、`ANTHROPIC_AUTH_TOKEN=magpie`、用户自己的 Key 被去掉；选默认 → 没有 `--model`，三个环境变量都没有。

## 自动化通过

- 直接跑上面两组 + K10a 的四组（core / IPC / 界面 / codex-review）：
  `7 + 2 + 9 + 2 + 3 + 2 = 25` 条；**25/25 通过**（命令：`node node_modules/vitest/vitest.mjs run --project acceptance <文件…>`）。
- `node scripts/verify.mjs`：**全部通过**（lint、format、local-user、typecheck、typecheck-acceptance、build、unit 69、integration 483、acceptance-lock 183、acceptance 1315、各 review 套件）。本机日志：`.logs/mg2-verify-2.txt`，退出码 0。verify 是在 rebase 到 `0fcfd06` 之前跑的；上游这一点只改了 SUB1 规格，代码与测试没变。
- GitHub 上的 verify：等调度器推上去后看；本棒不推送（只提交，RELAY-PUSH 交给调度器）。

## 真机通过

真机检查脚本：[`scripts/real/mg2-integrator-launch.mjs`](../../../scripts/real/mg2-integrator-launch.mjs)。合成一个最简调度器世界（临时裸仓库 + 队列 + 整合方工作目录），**不碰用户真实的 relay 目录 / 调度器配置**；用户在 magpie 里已建 `group/group-ixaeon-integrator`，用它真跑一棒：

```
magpie 的分组：3 个
== 乙（整合方）真的 relay once + 真的 Claude Code，模型 group/group-ixaeon-integrator
   relay once 退出码：0｜用时 19.1s
   第 1 棒 integrator integrator-review 行 70 → 待复审（整合方）
   记账：turn=1 role=integrator 行=70 → 待复审（整合方）｜退出码 0｜RELAY-DONE RELAY-DONE 70 已完成（2026-11-01）
== 结论：通过
```

（原样在 `.logs/mg2-integrator-real.txt`；临时目录和账户名由脚本遮掉。）

审查那一半没有在这一支跑：`codex-review.mjs` 的改动在 MG2b，它的真机检查也在 MG2b 交付说明里。面板的界面真机检查同样在 MG2b。

## 已知缺口

- **面板 + 审查脚本 + 它们的真机检查在 MG2b**，这一支单独合并不带界面；两支要一起复审。
- 验收测试未锁定（B 档本周例外）；整合方复审时锁，锁完再跑 `acceptance.mjs done`。
- 轮换本身是 magpie 的分组行为（`order` / `rotate` 等），IXAEON 只把选中的分组 id 交给各命令行；没有自己做轮换。
- 分组由用户在 magpie 里建、改；代码不建、不改 magpie 的分组。
- K9a / K9b（Codex、Claude 没额度时换 DSH 顶班）是否被这单取代，按规格留给整合方复审时定。
- 真机只在本机 magpie 上验证；别的机器上 magpie 的端口 / 分组名不同，要用户在设置里改地址、在 magpie 里建同名分组（或面板里选实际分组）。

## 用户接受

未发生（用户用过并认可之后才写）。