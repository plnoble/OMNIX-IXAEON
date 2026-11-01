# MG2b 整合方、审查、开发都走 magpie（第二支：面板与审查脚本） 交付

- 分支：`dev/MG2b`，基于 `dev/MG2`（先并第一支）；档位 **B**
- 执行方：dev
- 规格：[MG2-角色走magpie轮动.md](../MG2-角色走magpie轮动.md)
- 第一支：[MG2](MG2.md)（调度器起角色、配置读写）。按 AGENTS.md 的 300 行规矩拆开；整合方复审时先并 MG2，再并 MG2b。

## 已实现

1. **面板**（`CockpitRelayModels.tsx`）：
   - 整合方、审查两行的下拉里加本机 magpie 的模型和分组（第一支的 `readRelayModels` 已经把清单并进选项，界面这里只是把它们显示出来、选中就调 `setRelayModel`）；
   - 审查那行在原有 Codex 模型文本框之外多了 magpie 的下拉：选「默认」→ 清掉 `review.codexModel` 和 `review.magpieModel`；选 magpie 的值 → 写 `magpieModel`；
   - 连不上 magpie 时三行旁边显示「没连上 magpie」，原来的选项照旧。
2. **审查脚本**（`scripts/codex-review.mjs`）：`review.magpieModel` 有值 → 起 Codex 时用 `-c model_provider=magpie`、`-c model_providers.magpie.base_url=<magpie>/v1`、`-c model_providers.magpie.env_key=MAGPIE_KEY`，环境变量 `MAGPIE_KEY=magpie`，参数 `-m <id>`；同时带 `--ignore-user-config`（只这一条命令，**不碰** `~/.codex/config.toml`），并把 `127.0.0.1/localhost` 放进 `NO_PROXY/no_proxy`。没选 magpie 时参数、环境变量和现在逐字一样。

### 实机发现（写进代码的两处）

- **Codex 0.130/0.166 的默认 provider 不会因为设了 `OPENAI_BASE_URL` 就换网关**：实测它仍走 ChatGPT 登录、撞额度；必须用 `-c model_providers.*` 把它换成 magpie 的 OpenAI 兼容 provider。
- **本机系统代理会拦住连 magpie 的请求**：Codex 走 `127.0.0.1:7897` 的代理时对 `http://127.0.0.1:3425/v1/responses` 回 502（magpie 的 trace 里根本没有这条请求）。加 `NO_PROXY=127.0.0.1,localhost` 后同一命令答出 OK。这两处只有真跑才会发现，自动化替身测不到。

### 和规格不一样的地方

- 审查那一行**保留了原来那个 Codex 模型文本框**（K10a 已锁定在 main 的界面测试要求它还在），magpie 的下拉是旁边新增的；规格只要求「审查那一行有默认 + magpie 的模型和分组」。
- 选 magpie 时 `--ignore-user-config` 是规格没写、但必须的：用户 `~/.codex/config.toml` 里的 `service_tier` 在新版 Codex 里已经是非法值，不忽略就起不来；而且规格要求「不改」这个文件，忽略它是只读的、最干净的做法。

## 验收测试

- `apps/desktop/test/acceptance/mg2-panel.test.ts`（3 条）
  - 条件 1（界面）：整合方 / 审查的下拉含 `a/m1`、`b/m2`、`group/rot` 和「默认」；开发的下拉在原有选项之外有 `magpie / a/m1` 等；审查选 `group/rot` → `setRelayModel`、刷新后显示新值。
  - 条件 1 反面：连不上 magpie 时只有原来的选项，三行旁边写「没连上 magpie」。
- `packages/relay/test/acceptance/mg2-codex-launch.test.ts`（2 条）
  - 条件 3：审查选 `a/m1` → Codex 替身收到 `-m a/m1`、`model_providers.magpie.base_url=http://127.0.0.1:4321/v1`、`MAGPIE_KEY=magpie`、`NO_PROXY` 含本机；`~/.codex/config.toml`（测试里是临时 `CODEX_HOME`）逐字不变。
  - 默认 → 没有 `-m`、没有 magpie 的 provider 参数和 Key，config.toml 不动。

## 自动化通过

- 直接跑：MG2 + MG2b 的全部验收测试 + K10a 的四组（core / IPC / 界面 / codex-review）= **30/30 通过**。
- 第一支的 9 条（`mg2-magpie-models` 7 + `mg2-integrator-launch` 2）在 MG2b 工作目录里同样通过（MG2b 含 MG2 的全部改动）。
- `node scripts/verify.mjs`：**全部通过**（本机日志 `.logs/mg2b-verify.txt`，退出码 0）。verify 是在 rebase 到 `0fcfd06` 之前跑的；上游这一点只改了 SUB1 规格，代码与测试没变。
- GitHub 上的 verify：等调度器推上去后看；本棒不推送（只提交，RELAY-PUSH 交给调度器）。

## 真机通过

真机检查脚本：[`scripts/real/mg2-codex-launch.mjs`](../../../scripts/real/mg2-codex-launch.mjs)。合成一个最简 git 仓库，用真的 `codex-review.mjs`、真的 Codex；审查选用户在 magpie 里建的 `group/group-ixaeon-review`，**不碰 `~/.codex/config.toml`**：

```
magpie 的分组：3 个
== 甲（审查）真的 codex-review.mjs + 真的 Codex，模型 group/group-ixaeon-review
   codex-review.mjs 退出码：0
   结论：可以合并
   
   已写入 docs\委派\交付\demo-Codex审查.md
   结论文件开头：
   # demo Codex 审查
   
   - 时间：2026-11-01T13:06:11.669Z
   - 分支：master（8366ecc），对照 docs/委派/demo-合成规格.md
   - Codex：0.166.0；上下文由脚本喂入（不让 Codex 跑命令）
   
   没有发现问题
   结论：可以合并
== 结论：通过
```

（原样在 `.logs/mg2-codex-real.txt`；临时目录和账户名由脚本遮掉。）

整合方那一半的真机检查在第一支 MG2（`group/group-ixaeon-integrator`，`relay once` 记账通过），见 [MG2 交付说明](MG2.md)。

## 已知缺口

- **界面没在真实 Electron 里点过**：面板只跑了 jsdom 验收测试；真机上真正起应用点下拉的那一遍没有跑（本单只登记 **B 档，测试与实现一起交、不合并**；没跑的写没跑）。
- 验收测试未锁定（B 档本周例外）；整合方复审时锁。
- 分组轮换是 magpie 的行为；这一单只把分组 id 交给 Codex / Claude，没有自己做轮换。
- 只在本机 Windows + Codex 0.166 / Claude Code 上验证；别的 Codex 版本如果没有 `-c model_providers.*` / `--ignore-user-config`，要按版本调参数。

## 用户接受

未发生（用户用过并认可之后才写）。