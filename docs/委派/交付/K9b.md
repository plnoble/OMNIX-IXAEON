# K9b 整合方顶班 交付

- 分支：`dev/K9b`，基于 `dev/K9a`（`68b0185`），并已 `git merge origin/main`（`0244e61`）；档位 **B**（本周例外：测试和实现一起在分支上，不锁定、不合并）
- 执行方：dev

## 已实现

整合方（Claude）撞额度歇着时，复审 / 测试待审 / 飞书回复这三类活改派给**替补整合方**（DSH + 网关模型）；规划棒不派给它。形状照规格：

- 配置加可选的 `roles.integratorSubstitute: { argv, label }`（`argv` 同 `roles.developer`，含 `{prompt_file}`）；`config.example.json` 加了一段示例，`relay init` **不会**把它写进生成配置（否则会用示例里的占位补丁路径去起 DSH）。
- `decideNextTurn` 的返回多了 `role: 'integrator-substitute'`，`kind` 照用 `integrator-review` / `integrator-inbox`：
  - 整合方在歇 + 配了替补 → 先派飞书回复（有没办的），再派复审；状态里已含「替补审过」的行跳过；
  - 整合方没在歇、或者没配替补 → 行为一点不变；
  - 替补自己撞额度歇着 → 不接，开发那条道照常。
- 交代：在现有整合方交代前面加「你是替补整合方（`label`）」那段（能做 / 不能做），推送规矩换成「远端只能是 main 或 `integrate-sub/`」，最后一行仍是 `RELAY-DONE`；飞书回复棒也换成替补开头那段。
- 核对（`verify.ts`）加四种越界：`substitute-touched-main-code`（复审棒在 main 上改了 `docs/委派/` 以外）、`substitute-locked`（改了 `锁定验收.json`）、`substitute-migration`（改了 `packages/core/src/db/migrations.ts`）、`substitute-bad-branch`（推了 main / `integrate-sub/` 以外的分支）。分支这一条认两处：这一棒写过的 `RELAY-PUSH` 远端分支，和开棒前后 `git ls-remote --heads` 多出来的分支（替身直接推也抓得住）。
- 推送：替补标 `pushByRelay`，只许推 `main` 和 `integrate-sub/` 开头的分支。
- 记账 `role` 是 `integrator-substitute`；撞额度给 `pausedUntil['integrator-substitute']` 自己设，不影响开发。飞书的「撞额度」「处理了你的回复」「越界停下」都写「替补整合方（`label`）」。

改动文件与行数（`git diff --stat` 原样，未提交前的工作区）：

```
 docs/委派/交付/K9b.md                              | 109 +++++++++
 packages/relay/README.md                           |  22 +-
 packages/relay/bin/relay-main.ts                   |   3 +
 packages/relay/config.example.json                 |  13 +
 packages/relay/src/config.ts                       |  62 ++++-
 packages/relay/src/engine.ts                       |  55 ++++-
 packages/relay/src/index.ts                        |  17 +-
 packages/relay/src/notify/feishu.ts                |  27 ++-
 packages/relay/src/prompt.ts                       |  67 ++++-
 packages/relay/src/push.ts                         |  19 +-
 packages/relay/src/queue.ts                        |  23 +-
 packages/relay/src/run-turn.ts                     |   4 +-
 packages/relay/src/types.ts                        |  28 ++-
 packages/relay/src/verify.ts                       |  63 ++++-
 packages/relay/test/acceptance/k9b-decide.test.ts  | 235 ++++++++++++++++++
 packages/relay/test/acceptance/k9b-turn.test.ts    | 264 +++++++++++++++++++++
 scripts/real/k9b-substitute-integrator.mjs         | 196 +++++++++++++++
 17 files changed, 1165 insertions(+), 42 deletions(-)
```

`packages/relay/src` 是 +324 / -41（**净 +283**，按 AGENTS.md 的 300 行口径算源码；`bin/relay-main.ts` 那 3 行不计），其余是验收测试、真机脚本、README、配置示例和本说明。规格估的是「约 250 行；超了拆 K9b（派活与交代）/ K9c（核对与记账）」——净 283 没到 300，没拆；如果整合方按「增删合计」算成 365 行要拆，这里先说明，按您的口径处理。

和规格不完全一样 / 规格没写死、我定的地方：

- 替补的 `argv`、`label` 之外的参数规格没给：`cwd` 用整合方的工作目录（它要在里面读 main、提交文档），超时、额度字样、歇多久都照开发那份（都是 DSH 那一类）；`pushByRelay` 强制为 true（DSH 拿不到本机 git 凭据）。
- 写了 `integratorSubstitute` 但 `argv` / `label` 不合法：`checkConfig` **拒绝启动**并说清哪一条，不把它当「没配」。要改成 K9a 那种「当没配」只需改一处。
- 复审棒推 main 只许 `docs/委派/`；飞书回复棒按 L16 照旧只许 `docs/`——两处分开判，所以只给复审棒加 `substitute-touched-main-code`。
- `substitute-bad-branch` 除了看 `RELAY-PUSH` 行，还比开棒前后的远端分支。这会让每个替补棒多一次 `git ls-remote`（开发、整合方的棒没有）。
- 那一行状态写成什么样，调度器只核对「有没越界」，不核对后缀格式；格式写在交代里（`<原前缀>：替补审过（<日期>）：<结论>；<原来的要点>`）。和 L16 一样。

## 验收测试（v2 规格任务）

- `packages/relay/test/acceptance/k9b-decide.test.ts`（14 条）：条件 1（派替补 / 整合方没歇照旧 / 交代含那段 / 整合方交代不变）、条件 2（已「替补审过」跳过 / 全审过 idle / 替补自己歇）、条件 3（没配替补行为不变 / 半个替补当没配）、条件 5（规划不派替补 / 整合方当班照旧规划）、条件 4 的交代（替补飞书回复棒）。
- `packages/relay/test/acceptance/k9b-turn.test.ts`（8 条，合成仓库 + 替身 + 假飞书）：条件 1、8（派替补、记账 role、交代、状态）、条件 4（飞书回复、inboxDone、群里写明替补和 label）、条件 6（① main 上改 `packages/` ② 改锁定清单 ③ 改迁移 ④ 推 `dev/x` → 各自停下且记账有对应种类；只改队列那行 + 交付说明、推 `integrate-sub/70` → 不停）、条件 7、8（撞额度设 `pausedUntil['integrator-substitute']`、飞书写明、开发照常派活）。

规格条件 1–8 都有对应用例；本周例外不锁，`docs/委派/锁定验收.json` 里没有 K9b，`node scripts/acceptance.mjs run K9b` 取不到（没跑），按规格由整合方复审时锁。

## 自动化通过

- K9b 验收测试（直接跑 vitest）：

  ```
  ✓ |acceptance| packages/relay/test/acceptance/k9b-decide.test.ts (14 tests) 7ms
  ✓ |acceptance| packages/relay/test/acceptance/k9b-turn.test.ts (8 tests) 53004ms
  Test Files  2 passed (2)
       Tests  22 passed (22)
  ```

- 受影响的老测试（回归）：`l1-next-turn`、`l1-verify`、`l1-prompt`、`l6-prompt`、`l16-prompt`、`l16-inbox-turn`、`l9-decide`、`l9-prompt`，8 个文件 83 条全过（`Test Files 8 passed (8) / Tests 83 passed (83)`）。
- `node scripts/verify.mjs`：**退出码 1，只红在 `acceptance`（已完成任务的锁定验收测试）里的 L17**。它前面的 lint、format:check、local-user、typecheck、typecheck-acceptance、build、unit（69 条）、integration（483 条）、acceptance-lock（90 个任务 / 177 个锁定测试没被改）都通过。`acceptance` 一步原样：

  ```
  Test Files  1 failed | 165 passed (166)
       Tests  16 failed | 1272 passed (1288)
  ```

  16 条红全是 `l17-review-fallback.test.ts`。K9b 没动 `scripts/codex-review.mjs`；这是 K9a 分支上已知的那 16 条（K9a 交付说明「已知缺口」第 1 条，由整合方合并 K9a 时改）。提交后在干净的工作区又整套跑过一次，结果相同（完整日志在 `.logs/verify-k9b.log`、`.logs/verify-k9b-final.log`）。
- GitHub 上的 verify：**没看**（调度器替推，还没推上去）。

## 真机通过

**没跑**：`scripts/real/k9b-substitute-integrator.mjs` 要用户先建替补补丁 `~/.dsh/ixaeon-integrate.patch.yml`（模型由用户填；可以和审查替补共用一份），本机还没有这个文件。脚本输出原样：

```
没跑：等用户建补丁、选模型
（替补补丁不在：<家目录>\.dsh\ixaeon-integrate.patch.yml）
```

脚本已按规格写好并提交：临时裸仓库当 origin、临时 `relay-int` 工作目录当整合方的 cwd、`IXAEON_WORKTREES` 指到临时目录、不碰用户真实 relay 数据目录；合成队列一行「待复审（整合方）」、`pausedUntil.integrator` 设在两小时后、替补用真 DSH 启动器 + 用户补丁，跑一次 `relay once`，打印记账那一行、那一行在 `origin/main` 上的新状态、main 上改动的文件列表（只该有 `docs/委派/` 下的）；临时目录、家目录遮掉，不打印补丁内容、argv。按规格「没跑的不能合并」，等用户建好补丁后重跑。

## Codex 审查（A 档）

B 档，不跑 Codex，由整合方复审、锁定、合并。

## 已知缺口

1. **真机检查没跑**（见上）：等用户建 `~/.dsh/ixaeon-integrate.patch.yml`、选好模型后重跑。按规格没跑不能合并。
2. **L17 的 16 条锁定测试红**：从 K9a 分支继承（K9b 没改 `codex-review.mjs`）；K9a 交付说明里列了是哪 16 条，由整合方合并 K9a 时改。本分支的 `verify` 因此退出码 1，除这一处外全绿。
3. **K9b 测试没锁定**（本周例外）：没有任何 `acceptance.mjs lock`，`acceptance.mjs run K9b` 也没有；由整合方复审时锁。
4. **`git ls-remote` 没走 fetchMain 的回环代理绕行**：`verify.ts` 里多出来的那一次 `ls-remote` 直接用 `git()`；如果 origin 是回环地址、全局配了 `http.proxy`，可能慢或失败。失败时只认 `RELAY-PUSH` 那一层，直接推送的坏分支就抓不到（合成仓库里是本地地址，不受影响）。
5. **推 main 是「先推后查」**：替补把代码推上 main 时，调度器不会在推之前拦内容（拿不到「只改了 docs/委派/」这个事实），推完核对再停下、记账；和现有的规划棒 / 飞书回复棒同一处理方式。
6. **替补的额度字样 / 超时借的是开发那一份**：规格的 `integratorSubstitute` 契约只有 `argv`、`label`；如果以后网关模型的报错字样和 DSH 开发不同，要再加字段（本单没加，避免发明接口）。
7. **没有替用户真跑过一次真 DSH 替补**：单元 / 验收层只用替身证明调度逻辑；真 DSH + 用户网关模型的第一次见「真机通过」。

## 用户接受

未发生（用户用过并认可之后才写）。