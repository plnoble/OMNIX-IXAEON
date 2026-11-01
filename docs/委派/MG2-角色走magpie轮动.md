# 规格 MG2：整合方、审查、开发都走 magpie，可选模型和分组（额度用完自动换）

档位：**B**（改调度器起角色的方式和外发路径）。大小：中（约 250 行；超了拆 MG2 调度器起角色 / MG2b 面板与审查脚本）。依赖：K10a（已并入）。来源：用户 11-01：「整合方和审查我怎么选不了什么模型。他们应该多模型轮动，一个模型额度用完了自动切换下一个。」

v2 规格：先把验收条件写成测试（`packages/*/test/acceptance/mg2-*.test.ts`）。**本周例外（用户 10-31 定）**：测试和实现一起在分支上做完，状态改「待复审（整合方）」，不合并。

## 为什么这样做

magpie（本机 `127.0.0.1:3425`，https://github.com/yetone/magpie）已经会做轮动：**分组**（routing group，id 写成 `group/<名字>`）把几个模型编成一组，规则有 `order`（第一个答不了换下一个）、`rotate`（每轮换一个）、`smart`、`usage`、`pace`；而且 Claude Code、Codex 都能改走它的网关（README：「Claude Code on Kimi. Codex on DeepSeek」；网关同时说 Anthropic 和 OpenAI）。所以 IXAEON **不自己做轮换**：每个角色在面板上选「magpie 的一个模型或一个分组」，轮换交给 magpie。分组由用户在 magpie 里建、改。

这单做完，K9a / K9b（Codex、Claude 没额度换 DSH 顶班）多半用不着了：整合方复审时一起定去留。

## 要什么

1. **面板（K10a 的「调度器与模型」）**：
   - 整合方那一行的选项：「默认（Claude 自己的账号）」+ magpie 的全部模型和分组；
   - 审查那一行：「默认（Codex 自己的设置）」+ magpie 的全部模型和分组；
   - 开发那一行：照旧列 DSH 桌面版登记的网关模型，**另外把 magpie 的模型和分组实时列进来**（桌面版里 magpie 那节是手抄的静态清单，看不到后来建的分组）。
   - magpie 的清单现取 `GET http://127.0.0.1:3425/v1/models`（`Authorization: Bearer magpie`，3 秒超时，只认本机地址；地址沿用 SUB1 的 `cockpit.magpie_url`）；连不上就只列原来的选项，旁边写「没连上 magpie」。
2. **调度器起整合方**：选了 magpie 的模型或分组 → 起 Claude Code 时环境变量加 `ANTHROPIC_BASE_URL=<magpie>`、Key 用 `magpie`（照 magpie 文档里 Claude Code 的接法），参数里 `--model <id>`；选「默认」→ 和现在一样（不加这些）。
3. **审查脚本**（`scripts/codex-review.mjs`）：选了 magpie 的模型或分组 → 起 Codex 时照 magpie 文档里 Codex 的接法（OpenAI 兼容地址 `<magpie>/v1`、Key `magpie`）并 `-m <id>`；「默认」→ 照旧。**不改** `~/.codex/config.toml`，只在这一次命令的参数 / 环境变量里带。
4. **开发（DSH）**：选了 magpie 的模型或分组 → 写进接力补丁 `agent-default-model` 的 provider = 桌面版里 magpie 那节的名字、model = 选中的 id（分组也照写，DSH 经 magpie 网关调用时由 magpie 认）。
5. 选择存在调度器配置里：整合方 `roles.integrator.magpieModel`、审查 `review.magpieModel`（空 = 默认）；开发照 K10a 写补丁。

## 约束

- magpie 的 Key 就是字面量 `magpie`，不是密钥；但别的密钥（Claude、Codex 自己的登录）一律不碰、不读。
- 选「默认」时，起角色的命令和环境变量和现在**逐字一样**。
- 撞额度照旧：magpie 分组里都没额度、还是回了额度错误 → 照现在的撞额度处理（`pausedUntil`）。
- 不建、不改 magpie 的分组（那是用户在 magpie 里做的）。

## 验收条件

1. 合成 magpie（测试里的本地服务，`/v1/models` 回 `a/m1`、`b/m2`、`group/rot`）→ 面板整合方、审查两行的选项都含这 3 个和「默认」；开发那行在原有选项之外也有这 3 个。合成服务没起 → 只有原来的选项、写「没连上 magpie」。
2. 整合方选 `group/rot` → 调度器起整合方（替身）时收到 `--model group/rot`，环境变量里 `ANTHROPIC_BASE_URL` 是合成 magpie 的地址、Key 是 `magpie`；选回「默认」→ 参数和环境变量与现在逐字一样（不带这几项）。
3. 审查选 `a/m1` → Codex 替身收到 `-m a/m1` 和指向合成 magpie 的地址；「默认」→ 没有这些；`~/.codex/config.toml`（测试里指向临时目录）没被改。
4. 开发选 `group/rot` → 接力补丁里 `agent-default-model` 变成 magpie 那节的名字 + `group/rot`，其余字节不变、先有备份（沿用 K10a 的写法）。
5. 不认识的值（不在 magpie 清单里、也不是「默认」）→ 拒绝，配置不变。

## 真机检查

用户本机真的 magpie：在 magpie 里建一个分组（比如 `group/ixaeon-review`，`order`，两个成员），面板里审查选它；对一个合成的小分支跑一次 `codex-review.mjs`，贴出结论文件开头和退出码（不打印别的）。整合方那一行同样选一个 magpie 分组，让调度器跑一棒合成的复审（照 `scripts/real/l10-watchdog.mjs` 的合成仓库做法，不碰用户真实的 relay 目录），贴出记账那一行。没建分组就写「没跑：等用户在 magpie 里建分组」，没跑的不能合并。
