# 规格 K9b：整合方顶班（Claude 没额度换「DSH + 网关模型」当替补整合方，权限缩小）

档位：**B**（调度器派活、越界核对、谁能动 main——关卡本身）。大小：中（约 250 行；超了拆 K9b（派活与交代）/ K9c（核对与记账））。依赖：K9a（共用 `roles.*` 的配置写法；L11 两条道暂缓到 K9b 之后，两单都改 `engine.ts` / `verify.ts`）。来源：用户 10-31 定：Claude 没额度时换「DSH + 网关强模型」；排到最前面；模型可配置。驾驶舱第三阶段 K9 的另一半；cockpit 交接包当时定的边界照用：「整合：替补不合 main，只合阶段分支」。

v2 规格：先把验收条件写成测试（`packages/relay/test/acceptance/k9b-*.test.ts`）。**本周例外（用户 10-31 定）**：测试和实现一起在 `dev/K9b` 上做完，状态改「待复审（整合方）」，**不合并**。

## 要什么

调度器现在：整合方（Claude）撞额度 → `pausedUntil.integrator` 设到额度恢复，这期间所有整合方的活（复审、测试待审、飞书回复）都排队干等。改成：

1. 配置里有 `roles.integratorSubstitute` 时，整合方在歇（`pausedUntil.integrator` 在未来）期间，下面这几种整合方的活改派给**替补整合方**：
   - 「待复审（整合方）」「测试待审（整合方）」的行——**但状态里已经有「替补审过」的跳过**（替补审一次就够，留给 Claude 回来放行）；
   - 飞书回复棒（`integrator-inbox`）。
   - **规划棒不派给替补**。
2. 替补整合方**能做的**：读规格、测试、实现、交付说明，跑测试和变异检查，把复审意见写成交付说明的追加段「替补整合方预审（<日期>，<标签>）」；B 档测试有问题，可以把改正后的测试提交到 `integrate-sub/<任务号>` 分支；飞书回复照现在的飞书回复棒办（只改 `docs/`）。
3. 替补整合方**不能做的**（跑完核对，越界就停下，照现在的越界处理）：
   - 推 main 时只许改 `docs/委派/` 下的文件（队列那一行、交付说明的追加段），飞书回复棒照旧只许改 `docs/`；
   - 不许改 `docs/委派/锁定验收.json`（不锁、不 `done`）；不许改 `packages/core/src/db/migrations.ts`；
   - 代码只许推到 `integrate-sub/` 开头的分支，不许推 main、不许推 `dev/` 分支。
4. 替补审完，那一行状态改成「待复审（整合方）：替补审过（<日期>）：<一句话结论>；<原来的要点>」或「测试待审（整合方）：替补审过（<日期>）：…」——仍然以原来的前缀开头，Claude 回来后照常接；有「替补审过」所以替补不再接。
5. 记账：`role: 'integrator-substitute'`；飞书通知里写明「替补整合方（<标签>）」。

## 契约

- 配置加可选的 `roles.integratorSubstitute`：`{ "argv": string[], "label": string }`，`argv` 写法同 `roles.developer`（含 `{prompt_file}`），一般是 DSH 加一份只换模型的补丁（和 K9a 的替补审查可以是同一份）。`config.example.json` 加示例。
- `decideNextTurn` 的返回加 `role: 'integrator-substitute'` 一种；`kind` 照用 `integrator-review` / `integrator-inbox`。整合方没在歇时行为一点不变；没配替补时行为一点不变。
- 交代（prompt）：在现有整合方交代前面加一段逐字的「你是替补整合方」说明（能做 / 不能做，照上面第 2、3 条），最后一行照旧 `RELAY-DONE`。
- 核对（`verify.ts`）：加越界种类 `substitute-touched-main-code`（main 上改了 `docs/委派/` 以外）、`substitute-locked`（改了锁定清单）、`substitute-migration`（改了迁移）、`substitute-bad-branch`（推了 `integrate-sub/` 以外的分支）。
- 替补撞额度：照现有撞额度的处理，给 `integrator-substitute` 自己设 `pausedUntil`，不影响开发那条道。

## 约束

- 只改 `packages/relay/`（含 README：怎么配替补、补丁怎么建、替补能做什么不能做什么）。
- Claude（`roles.integrator`）在的时候，替补一次都不派。
- 不改 L16 的飞书回复棒逻辑本身，只是让它在整合方歇着时能由替补来办。
- 锁定测试不改；撞红的列进交付说明，由整合方改。

## 验收条件

1. 整合方在歇、配了替补、队列有一行「待复审（整合方）」→ 派给 `integrator-substitute`，交代里含「你是替补整合方」那一段；整合方没在歇 → 照旧派给整合方。
2. 那一行状态已含「替补审过」→ 替补不接，看下一行；全都审过 → 没活（idle），不派。
3. 没配替补 → 和现在一模一样（整合方在歇就不派整合方的活）。
4. 飞书回复：整合方在歇、有没办的回复 → 派给替补的飞书回复棒；办完 `inboxDone` 记上、群里的通知写明是替补。
5. 规划：整合方在歇时不派规划棒给替补（哪怕到了规划的点）。
6. 越界：合成仓库里替补替身分别①在 main 上改了 `packages/` 下的文件、②改了 `锁定验收.json`、③改了迁移文件、④推了 `dev/x` 分支 → 各自停下，记账里有对应的越界种类；替身只改了队列那一行和交付说明、推了 `integrate-sub/x` → 不停下，那一行的新状态以原前缀开头、含「替补审过」。
7. 替补撞额度 → `pausedUntil['integrator-substitute']` 设上，开发那条道照常派活。
8. 记账里 `role` 是 `integrator-substitute`；飞书通知文字含「替补整合方」和配置的 `label`。

## 真机检查

`scripts/real/k9b-substitute-integrator.mjs`（照 `scripts/real/l10-watchdog.mjs`：临时裸仓库当 origin、`IXAEON_WORKTREES` 指到临时目录、**不碰用户真实的 relay 数据目录**）：合成队列一行「待复审（整合方）」、`pausedUntil.integrator` 设在未来、替补用真 DSH + 用户自建的替补补丁，跑一棒：贴出记账那一行、那一行的新状态、main 上的改动文件列表（应只有 `docs/委派/`）。用户还没建替补补丁就写「没跑」，没跑的不能合并。
