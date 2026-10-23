# 委派单 L13：替开发推 main 被拒时，先 rebase 再推一次

档位：**A**（推的还是开发自己的提交、只快进、不强推，没有放开新的权限）。大小：小（约 40 行源码）。依赖：无。来源：2026-10-23 起接力调度器旁边多了一个窗口里的开发 agent（dev2）。DSH 一棒里的提交要等这一棒结束才由调度器替它推；这期间 main 只要被别人推过，替推就被拒，整个调度器停下（第 4 棒之后整合方和 dev2 都只能躲着 DSH 那一棒推）。

## 要什么

调度器替开发推 `main`（`RELAY-PUSH <目录> <本地> main`）被拒时，不马上停：在那个目录里把这一笔 rebase 到最新的 `origin/main` 上，再推一次。rebase 冲突了、或者第二次还推不上，再照原来停下。推 `dev/` 分支不变（被拒照原来算失败）。

## 契约（接口写死，不改名、不加字段）

1. 只改 `packages/relay/src/push.ts` 里推的那一段（`relayPushes`）。「先全部查一遍，有一条不过就一条都不推」那一段不变。
2. 某一条的 `remote` 是 `main`、`git push` 退出码不是 0，并且 `local` 是 `HEAD` 或者正是 `dir` 里当前检出的分支 → 依次在 `dir` 里跑：
   - `git fetch origin main`
   - `git rebase FETCH_HEAD`：失败 → `git rebase --abort`，这一条算失败（和现在一样记 `ok: false`、停下、后面的不推）；
   - 成功 → 再 `git push origin <local>:refs/heads/main` 一次：成功记 `ok: true`，失败照原来停下。
   别的情况（`local` 不是当前检出的、推的是 `dev/` 分支）不重试，照原来。
3. `PushRecord` 加一个可选字段 `rebased?: boolean`：走过第 2 条、rebase 成功的那一条写 `true`，别的不写。
4. 不加 `--force`、不加 `+`，不动 `dir` 以外的任何目录。

## 约束

- 只改 `packages/relay/`。已锁定的测试不改。L6 条件 5 那条整合方 2026-10-23 已经改成「别人和开发改同一个文件」（rebase 会冲突），L13 前后都应该过。
- 推之后的越界核对照旧（`verifyTurn` 不改）。

## 验收

新测试 `packages/relay/test/acceptance/l13-rebase-push.test.ts`，照 `l6-push.test.ts` 的合成仓库做法（`l6-harness.ts` 可以用），逐条：

1. 裸仓库 main 先被别人推了一笔**别的文件**，开发这一棒提交了自己的一笔、`RELAY-PUSH <dev> relay-dev main`（`relay-dev` 是检出的分支）→ 推上去了：裸仓库 main 上两笔都在、开发那一笔在别人那一笔后面；记账那一条 `ok: true`、`rebased: true`；没停下。
2. 别人那一笔改的是**同一个文件**（rebase 冲突）→ 停下、`stoppedReason` 含「第 1 棒替开发推送失败：」；裸仓库 main 还是别人那一笔（没被强推）；开发目录里没有留着没做完的 rebase（`git status` 里没有 rebase 进行中）。
3. 推 `dev/x` 被拒（裸仓库上那个分支被别人推过）→ 不重试、照原来停下，记账那一条没有 `rebased`。
4. `local` 不是检出的分支（比如目录里检出的是 `a`、推的是 `b`）、main 被拒 → 不重试、照原来停下。
5. 没被拒的推送记账里没有 `rebased`（L6 原来的那几条照过）。

`node scripts/acceptance.mjs lock L13 …` 登记；`node scripts/verify.mjs` 全过；`node scripts/codex-review.mjs L13`；照 AGENTS.md 合并。
