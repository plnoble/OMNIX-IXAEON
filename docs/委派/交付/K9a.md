# K9a 审查顶班 交付

- 分支：`dev/K9a`，基于 `main` `5820161`；档位 **B**
- 执行方：dev

## 已实现

`node scripts/codex-review.mjs <任务号>` 的兜底从「Codex 没额度 → Claude 代审（L17）」换成「Codex 没额度 → 调度器配置里的替补审查」（K9a）：

- 读 `<数据目录>/config.json` 的可选 `roles.reviewer`：`{ argv: string[], label: string, timeoutSeconds?: number }`。`argv` 的写法同 `roles.developer`，含 `{prompt_file}` 占位（也认嵌在参数里的写法）和 `{relay_root}`；`timeoutSeconds` 默认 1200。
- Codex 报额度用完时：把同一份审查上下文和要求（规格、AGENTS.md、交付说明、diff，另加一句「只读审查：不许改任何文件、不许提交、不许推送」）写进提示文件，在一个临时的 `git worktree add --detach <临时目录> HEAD` 里跑替补；跑完 `git worktree remove --force` + `prune`，被审的工作目录不动。
- 结论写同一个 `docs/委派/交付/<任务号>-Codex审查.md`，开头写 `# <任务号> 审查（Codex 额度用完，由替补审查代审（<label>））`，元信息只写 label、分支、时间，不写 argv、临时目录、补丁内容。
- 退出码：替补输出里最后一个「结论：可以合并 / 需要修改」→ 0 / 1；认不出 → 2；超时（杀整棵进程树）→ 2；输出里有 `quotaPatterns` 的额度字样 → 3；没配 `roles.reviewer` → 3，输出说「Codex 额度用完、没配替补审查」。
- 去掉 L17 的 Claude 代审（`CLAUDE_BIN`、`roles.integrator.argv[0]` 那一段）；`quotaPatterns` 仍按 L17 从 `roles.integrator.quotaPatterns` 读，没有就用 `usage_limit_reached` / `session limit` 两条。
- 区分输出：DSH `--json` 的 `final.text`、整行 JSON 的 `result` 字段、普通文字都认；工具调用、工具结果、思考这些 JSON 事件不算审查正文。
- `roles.reviewer` 配了但 `argv` 不合法（不是非空字符串数组）当作没配，退 3。

改动文件与行数（`git diff --stat origin/main...HEAD` 原样）：

```
 docs/委派/交付/K9a.md                              | 120 ++++++
 packages/relay/README.md                           |  23 +-
 packages/relay/config.example.json                 |  14 +
 .../test/acceptance/k9a-substitute-review.test.ts  | 455 +++++++++++++++++++++
 scripts/codex-review.mjs                           | 267 +++++++++---
 scripts/real/k9a-substitute-review.mjs             | 166 ++++++++
 6 files changed, 979 insertions(+), 66 deletions(-)
```

源码只有 `scripts/codex-review.mjs` 一处（+202 / -65，净 +137 行）；其余是验收测试、真机检查脚本、配置示例、README 和交付说明，按 AGENTS.md 不计入 300 行。

和规格不完全一样的地方：

- **提示文件放在临时 worktree 里**（`.ixaeon-review-prompt.md`）：替补的沙箱至少保证读得到自己的 cwd，放在外面可能读不到；它仍在临时副本里，跑完连副本一起删。
- **结论文件也写进被审工作目录**，所以验收条件 5 的「`git status` 前后一样」按「除了脚本自己写的 `K9a` 结论文件以外一样」比较，并另外断言替身新建/改动的文件一个都没出现在被审工作目录里（测试里有注释说明）。
- **替补的额度字样沿用 `roles.integrator.quotaPatterns`**：规格的 `roles.reviewer` 契约只有 `argv`、`label`、`timeoutSeconds`，没给替补单独配额度字样。

## 验收测试（v2 规格任务）

文件：`packages/relay/test/acceptance/k9a-substitute-review.test.ts`（9 条用例；开头注释逐条对应规格条件 1–8）。

| 规格条件 | 用例 |
| --- | --- |
| 1 | Codex 报额度、`roles.reviewer` 给结论「可以合并」→ 退 0；结论文件开头含「由替补审查代审」和 label；提示文件里含与 Codex 同样的一份上下文（规格、AGENTS.md、交付说明、diff、审查要求、只读约束） |
| 2 | 同上，替身输出「需要修改」→ 退 1 |
| 3 | 设 `CLAUDE_BIN`、`roles.integrator.argv` 也指向 Claude 替身 → Claude 替身调用记录为空 |
| 4 | 没配 `roles.reviewer` → 退 3、输出「Codex 额度用完、没配替补审查」；只有 Codex 被调用 |
| 5 | 替身在自己 cwd 里新建/改动文件 → 被审工作目录没有这些改动；`git worktree list` 里没有残留的临时 worktree |
| 6 | 没有结论行 → 退 2；超过 `timeoutSeconds` → 退 2，心跳文件停止增长（进程被结束），worktree 清掉 |
| 7 | 替身输出含配置里的额度字样 → 退 3，不写结论文件 |
| 8 | Codex 没撞额度 → 替补一次都没被调用，行为和原来一样 |

注：本周例外（用户 10-31 定）B 档测试不锁定，`docs/委派/锁定验收.json` 里没有 K9a；按规格由整合方复审时锁。

## 自动化通过

- K9a 验收测试（直接跑 vitest，因为还没锁定、`acceptance.mjs run` 取不到）：

  ```
  node node_modules/vitest/vitest.mjs run --project acceptance packages/relay/test/acceptance/k9a-substitute-review.test.ts
  ✓ ...k9a-substitute-review.test.ts (9 tests) 30326ms
  Test Files  1 passed (1)
       Tests  9 passed (9)
  ```

- `node scripts/acceptance.mjs run K9a`：**没跑**，B 档本周例外不锁定（见上）。
- `node scripts/verify.mjs`：**退出码 1，只红在 `acceptance`（已完成任务的锁定验收测试）里的 L17**；它前面的 lint、format、local-user、typecheck、typecheck-acceptance、build、unit（69 条）、integration（483 条）、acceptance-lock（90 个任务 / 177 个锁定测试没被改）都通过。`acceptance` 一步原样：

  ```
  Test Files  1 failed | 165 passed (166)
       Tests  16 failed | 1272 passed (1288)
  ✗ acceptance（已完成任务的锁定验收测试） 失败（287.7s）
  ```

  L17 的 16 条用例红、2 条绿，详见「已知缺口」第 1 条。
- GitHub 上的 verify：**没看**（调度器替推，还没推上去）。

## 真机通过

**没跑**：`scripts/real/k9a-substitute-review.mjs` 要用户先建替补补丁 `~/.dsh/ixaeon-review.patch.yml`（模型由用户填），本机还没有这个文件。脚本输出原样：

```
没跑：等用户建补丁、选模型
（替补补丁不在：<家目录>\.dsh\ixaeon-review.patch.yml）
```

脚本本身已按规格写好并提交：临时合成仓库（一处明显的 bug 的分支）+ `CODEX_BIN` 报额度用完的替身 + 真 DSH 启动器 + 用户补丁，跑一次审查、遮掉临时目录/家目录，贴结论文件开头几行和退出码，不打印补丁内容和 argv。按规格「没跑的不能合并」，等用户建好补丁、选好模型后重跑。

## Codex 审查（A 档）

B 档，不跑 Codex，由整合方复审、锁定、合并。

## 已知缺口

1. **L17 锁定验收测试会红，按规格执行方不改，由整合方合并时改。** 文件 `packages/relay/test/acceptance/l17-review-fallback.test.ts`，16 条红（2 条绿：条件 1「Codex 正常给结论」、条件 9「Codex 别的失败」）：
   - 条件 2：退 0；记录第一行写着 Claude 代审，含审查者、花费、结论；标准错误说明换了谁
   - 条件 2：JSON 里没有 total_cost_usd → 不写花费那一行
   - 条件 3：「结论：需要修改」→ 退 1，记录写着
   - 条件 3：最后一行别的话 → 退 2（确实走到了 Claude）
   - 条件 4：参数正好那一串、stdin 与 Codex 一样、cwd 在仓库外且是新的空临时目录、无禁用开关
   - 条件 4：`.js` 结尾的 CODEX_BIN / CLAUDE_BIN 也经 node 起（契约第 4 条）
   - 条件 5：`is_error: true` 的会话额度 JSON；标准错误含「Claude 也没额度了」
   - 条件 5：默认额度字样各自单独认：session-text（只有 Session Limit（大写、标准输出、不是 JSON））
   - 条件 5：默认额度字样各自单独认：usage-stderr（只有 USAGE_LIMIT_REACHED（大写、标准错误））
   - 条件 6：不是 JSON 的一句话、退出码 1；标准错误含「Claude 没有给出结论」
   - 条件 6：是 JSON 但没有 `result` 字段 → 同样退 2（契约第 5 条）
   - 条件 7：`roles.integrator.argv[0]` 指向替身 → 用它，结果同条件 2
   - 条件 7：CLAUDE_BIN 和配置都有 → 先用 CLAUDE_BIN（契约第 3 条的顺序）
   - 条件 7：配置里的 `quotaPatterns` 当额度字样用 → 退 3
   - 条件 8：没有 CLAUDE_BIN、数据目录也没有 config.json；标准错误含「也没找到可用的 Claude」
   - 条件 8：config.json 不是 JSON → 当作没有（契约第 3 条）
2. **真机检查没跑**（见上）：等用户建 `~/.dsh/ixaeon-review.patch.yml`、在 `roles.reviewer` 里选模型后重跑；按规格没跑不能合并。
3. **`AGENTS.md` 还是旧的**：合并一节的「Codex 额度用完换 Claude 代审」由整合方合并时改（规格明确这一步归整合方）。
4. **和 K10a 分支的合并冲突**：K10a 也改了 `scripts/codex-review.mjs`（把 `const integrator = readRelayConfig()?.roles?.integrator` 拆成 `relayConfig` 并加 `review.codexModel` → `-m`）。两边都动同一处，合并 K10a 之后再并 K9a 时以 K9a 的 `relayConfig` 写法为底，把 K10a 的 `codexModel` / `-m` 接回 `codex exec` 那一行。K10a 的「替补审查」行读的就是 `roles.reviewer.argv` 的 `--patch`，和 K9a 是同一个键，不用改名。
5. **没有替用户真跑过一次真 DSH 替补**：单元/验收层只用替身证明调度逻辑；真 DSH + 用户网关模型的第一次见「真机通过」。
6. 结论文件按「最后一个含 `结论：可以合并/需要修改` 的行」认（替补）；Codex 那段照旧只认最后一行，行为没变。

## 用户接受

未发生（用户用过并认可之后才写）。