# 规格 K9a：审查顶班（Codex 没额度换「DSH + 网关模型」，不再找 Claude）

档位：**B**（改的是审查这道关卡本身：谁来审、审出的结论算不算数）。大小：小（约 150 行，主要在 `scripts/codex-review.mjs`）。依赖：无。来源：用户 10-31 定（[三周任务单](../三周任务单.md)「额度」一节）：现在限制最大的是额度；Codex 没额度时**不应该给 Claude**（Claude 额度要留给整合方），换「DSH + 网关里的强模型」；排到最前面；用哪个模型先不定，做成可配置。驾驶舱第三阶段 K9「顶班」提前做的第一半（另一半 K9b 是整合方顶班）。

v2 规格：先把验收条件写成测试（`packages/relay/test/acceptance/k9a-*.test.ts`）。**本周例外（用户 10-31 定）**：整合方歇到 11-05 凌晨 4:30，B 档不等锁定，测试和实现一起在分支 `dev/K9a` 上做完、推上去，状态改「待复审（整合方）」，**不合并**；整合方回来一起审、锁、并。

## 要什么

`node scripts/codex-review.mjs <任务号>` 现在：Codex 审 → Codex 额度用完就找 Claude 代审（L17）→ Claude 也没有才退 3。改成：

1. Codex 审（不变）。
2. Codex 额度用完 → **替补审查**：调度器配置里配了 `roles.reviewer`，就用它（一般是 DSH，用一份只选模型的补丁配置，模型由用户在补丁里填，比如网关里的 `claude-sonnet-4-6`、`glm-5.3`）。同一份审查上下文和要求，结论照样写进 `docs/委派/交付/<任务号>-Codex审查.md`，开头注明「由替补审查代审（<标签>）」。
3. **不再找 Claude**：去掉 L17 的 Claude 代审（`CLAUDE_BIN`、`roles.integrator.argv[0]` 那一段）。没配替补、或替补也撞额度 → 退 3（分支等着，和现在一样）。

## 契约

- 调度器配置（`<数据目录>/config.json`）加可选的 `roles.reviewer`：`{ "argv": string[], "label": string, "timeoutSeconds"?: number }`。`argv` 的写法和 `roles.developer` 一样，含 `{prompt_file}` 占位（脚本把审查上下文和要求写进这个文件、替换进去）；`label` 是给人看的「DSH + newapi/某模型」，写进结论文件开头；`timeoutSeconds` 默认 1200。`config.example.json` 加一段示例（模型那里写占位，不写用户的真实网关）。
- 替补**在一个临时的、只读用途的 git worktree 里跑**（基于被审分支的 HEAD，`--detach`），跑完删掉：替补要是改了文件，也只改在临时副本里，被审的工作目录一个字不动。
- 结论照现有的认法：替补的输出里最后一个「结论：可以合并 / 需要修改」决定退出码 0 / 1；认不出 → 退 2；超时 → 退 2；输出里有额度用完的字样（沿用 `quotaPatterns` 的认法）→ 退 3。
- 退出码含义不变（0 / 1 / 2 / 3），`AGENTS.md`「合并」一节关于 Claude 代审的那几句由整合方合并时改。

## 约束

- 替补审查只读：提示词里写明不许改文件、不许提交、不许推送；脚本另外靠临时 worktree 兜底。
- 不碰用户真实的 DSH 配置：替补用的补丁文件由用户自己建（README 写清：把 `~/.dsh/ixaeon-relay.patch.yml` 复制一份，只改最下面 `agent-default-model` 的 provider / model 两行）。
- 不打印、不记录补丁文件里的密钥；结论文件、日志里不出现网关地址。
- **L17 锁定的测试里「Codex 没额度改用 Claude」那几条会撞红**：执行方不改，交付说明里列出（文件、用例名），由整合方合并时改。

## 验收条件

1. Codex 替身报额度用完、`roles.reviewer` 指向一个替身（它把收到的提示文件内容存下来、输出「结论：可以合并」）→ 退出码 0；结论文件开头含「由替补审查代审」和配置里的 `label`；替身收到的提示文件里有和 Codex 那次同样的审查上下文（规格、AGENTS.md、交付说明、diff）。
2. 同上，替身输出「结论：需要修改」→ 退出码 1。
3. **设了 `CLAUDE_BIN`、`roles.integrator.argv` 也指向一个 Claude 替身** → Claude 替身一次都没被调用（替身被调用会留下标记文件，测试断言没有）。
4. 没配 `roles.reviewer` → 退出码 3，输出说「Codex 额度用完、没配替补审查」；不调用任何别的东西。
5. 替身在自己的工作目录里新建、改动文件 → 被审的工作目录 `git status` 前后一样；临时 worktree 跑完不在了（`git worktree list` 里没有）。
6. 替身输出没有结论行 → 退 2；替身超过 `timeoutSeconds` → 退 2，进程被结束（不留孤儿进程）。
7. 替身输出里有额度用完的字样 → 退 3。
8. Codex 没撞额度时 → 替身一次都没被调用（行为和现在一样）。

## 真机检查

`scripts/real/k9a-substitute-review.mjs`：临时合成仓库里造一个小分支（一处明显的 bug），`CODEX_BIN` 指向一个报额度用完的替身，`roles.reviewer` 用真的 DSH 和用户自建的那份替补补丁（模型由用户填），跑一次审查：贴出结论文件开头几行和退出码（遮掉临时目录、不打印补丁内容）。用户还没建替补补丁就写「没跑：等用户建补丁、选模型」，**没跑的不能合并**。
