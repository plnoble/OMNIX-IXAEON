# L6b DSH 自己的仓库 交付

- 分支：`dev/L6b`，基于 main `5976bbe`；档位 **B**
- 执行方：dev。验收测试由整合方写好并锁定（`l6b-launcher` `l6b-layout` `l6b-init`），本单只写实现 + 真机检查乙。

## 已实现

| 文件                               | 改动   | 什么                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/relay/bin/dsh.mjs`       | +4 −1  | 起 DSH 时：`IXAEON_WORKTREES` **没有设就设成自己的当前目录**（调度器起开发时的 `cwd`），设了就不动——这样 DSH 里跑的 `scripts/worktree.mjs` 把工作目录建在它自己的根下面                                                                                                       |
| `packages/relay/src/push.ts`       | +31 −3 | 「同一个仓库」那道检查**多加一条**：`dir` 的 `--git-common-dir` 在这个角色的 `cwd` 里面，**并且** `dir` 的 `origin` 和调度器所在仓库的 `origin` 是同一个地址（去掉末尾的 `/` 和 `.git`，Windows 上不分大小写）。照旧那条（`--git-common-dir` 一样）仍然有效                   |
| `packages/relay/src/prompt.ts`     | +17 −8 | `pushByRelay` 的交代在 L6 那段后面再加一句（逐字）：`你的仓库是 <cwd>/repo：AGENTS.md 里说的「共用检出目录」换成它；工作目录照 AGENTS.md 用 node scripts/worktree.mjs 建，会落在 <cwd> 下面。`——`<cwd>` 是这个角色 `cwd` 的绝对路径，`/repo` 字面拼接                         |
| `packages/relay/bin/relay-main.ts` | +17 −1 | `relay init`：开发的 `cwd` 改成 `<工作目录根>/dsh`；`<工作目录根>/dsh/repo` 不存在就**本地克隆**（`git clone <仓库根> <它>`，不走网络），再把它的 `origin` 改成调度器所在仓库的 `origin` 地址；已经存在就不动。克隆失败：打印「建不了开发的仓库：<原因>」、退出码 1、不写配置 |
| `packages/relay/src/run-turn.ts`   | +1     | 把角色的 `cwd` 也传给交代（那句要拼真实路径）                                                                                                                                                                                                                                 |

源码改动（只算 `packages/relay/src` 和 `bin`）**70 行**，上限 300。

没动任何锁定测试（`l6-*`、`l6b-*`、L1–L5 都没改；L6 那一条「cwd 里另外 git init 的仓库」是整合方为这一单改过并重锁的，我一个字没碰）。

## 自动化通过

- `node scripts/acceptance.mjs run L6b`：**8 条全过**（`l6b-launcher` 2、`l6b-layout` 5、`l6b-init` 1）。
- 回归：`L1` 54、`L1b` 18、`L2` 12、`L2b` 19、`L3` 28、`L4` 15、`L5` 4、`L6` 15，**全过**。
- `node scripts/verify.mjs`：**全过**（2026-10-23 14:4x，末行「全部通过（IXAEON v0.2 验证完成）」）。
- 跑完确认 `git worktree list` 里没有残留的临时工作目录（`relay init` 的测试自己收尾）。

## 真机通过

**乙：真 DSH + 调度器替推——一次跑通。DSH 真调用 1 次（上限 2，没用满）。**

`scripts/real/l6-relay-push.mjs`（照 L6b 布局重写）：临时裸仓库当 `origin`、一份合成「调度器所在仓库」、开发的工作目录根 `<临时目录>/dsh` 里一份**独立克隆** `repo`（`.git` 在它里面，`origin` 是那个临时裸仓库）；开发用**真 DSH**（`pushByRelay: true`，走真的 `packages/relay/bin/dsh.mjs` 启动器），整合方用替身，`relay once`。不连 GitHub。

原样输出（遮掉临时目录）：

```
== 乙：真 DSH + 调度器替推（origin 是本地裸仓库，不连 GitHub）
   合成仓库建好：裸 origin + 调度器所在仓库 + 开发自己的克隆（.git 在 repo 里面）
   开棒前裸仓库 main = 1dc962b2cfd7
   relay once 退出码 0｜用时 32.8s
   它说的：第 1 棒 developer developer-claim 行 70 → 测试待审（整合方）
   DSH 原样输出（9139 字，遮掉临时目录，截 1200）：
   {"type":"session","sessionId":"session-41b565e5-5027-4845-a751-2b697f24c28e","cwd":"<临时目录>\\dsh"}
   ...
   {"type":"tool_call",...,"tool":"read","input":{"file_path":"<临时目录>\\relay\\turns\\1\\prompt.md"}}
   ...
   {"type":"text","text":"队列中第 70 行的状态已从「待领」改成「测试待审（整合方）」，改动已提交。
    RELAY-PUSH <临时目录>\\dsh\\repo dev/l7-synthetic main
    RELAY-DONE 70 测试待审（整合方）"}
   它写了 RELAY-PUSH：true｜RELAY-DONE：true
   额度字样（两路都查）：没出现
   裸仓库分支：main
   裸仓库 main：1dc962b2cfd7 → 76dd0b1d4ed5（前进了=true）
   开发那份克隆的分支：dev/l7-synthetic、main
   开发那份克隆里 git status：## dev/l7-synthetic
   记账：turn=1 role=developer exit=0 越界=[]
   记账 pushes：[{"dir":"<临时目录>\\dsh\\repo","local":"dev/l7-synthetic","remote":"main","ok":true}]
   记账 statusAfter=测试待审（整合方）｜doneLine=RELAY-DONE 70 测试待审（整合方）
```

逐条结论：

| 看什么                 | 结果                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| DSH 读得到交代吗       | **读到了**（`turns/1/prompt.md` 的 read 调用，内容原样在里面，含 L6 和 L6b 两段）                                                               |
| 交代里 L6b 那句对不对  | **对**：`你的仓库是 <临时目录>\dsh\repo：…工作目录…会落在 <临时目录>\dsh 下面。`                                                                |
| 在自己那份里提交得了吗 | **提交得了**：`## dev/l7-synthetic`、工作区干净（上一轮的「沙箱拒绝写入」没有了）                                                               |
| 写出 `RELAY-PUSH` 了吗 | **写了**：写在 DSH `--json` 的 `final.text` 里（`RELAY-PUSH <repo> dev/l7-synthetic main`），调度器照 `parsePushLines` 从 `final.text` 认了出来 |
| 调度器推上去了吗       | **推上去了**：裸仓库 `main` 前进了（`1dc962b2… → 76dd0b1…`），记账 `pushes` 一条 `ok: true`                                                     |
| 没提权限/没连 GitHub   | **是**：全程没出现「要不要切完全权限」，`origin` 是临时裸仓库；额度字样两路都查了，没出现                                                       |

**上一轮为什么没成，这一轮为什么成**：上一轮开发的目录是 `git worktree`，`.git` 在共用检出目录那边、不在 DSH 的工作目录里，它的沙箱写不了 `.git`，提交不了（原话：「等用户：是否切到完全权限以便提交（git 目录在工作区外，沙箱拒绝写入）」）。这一轮开发的根 `<工作目录根>/dsh` 里是一份**独立克隆**，`.git` 在它自己里面 → git 只写自己的目录，提交得成；替推那边新加的那条检查正好认这种「`cwd` 里的独立克隆、origin 和调度器的一样」。

**两处要如实说的**：

1. 真调用用了 **1 次**（上限 2）。跑通之后没有为「再确认一次」花第二次——输出已完整落盘到 `.logs/l6-turn-transcript.txt`，够核对。
2. 合成世界里有**两处为演练搭的便利**（不是产品行为）：① 合成仓库里放了一份手写的 `AGENTS.md`（真仓库里那份不适用于合成队列）；② DSH 的 `cwd`（`<工作目录根>/dsh`）里也放了一份 `AGENTS.md` 指路「你的仓库是 `./repo`」。生产里这两份由真仓库和 `relay init` 提供。

## 用户接受

未发生。

## 已知缺口

1. **`relay init` 只在「配置不存在」时才建 `dsh/repo`**：第二次跑（配置已在）会直接返回「已经有配置了，没改」，不动仓库——这是照契约第 4 条「已经存在就不动」。但**配置存在而 `dsh/repo` 被删掉**时，`init` 不会补建（它压根没走到那一步）。要补的话得单独一个「补建」动作，这一单没做。
2. 用户本机的 `relay init` 配置和 `<工作目录根>/dsh/repo` 要**重新生成**（照规矩归整合方并入之后做，我没碰用户本机的数据目录和 `Worktrees\IXAEON\dsh`）。
3. 真机检查只验了「DSH 自己提交、调度器替推 `main`」这一条路；**DSH 照 AGENTS.md 建任务工作目录**（`node scripts/worktree.mjs`，会落在 `<cwd>` 下面）那一条只在合成 `AGENTS.md` 里让它「别建」，没有真跑——它建出来的目录也在 `<cwd>` 里面、`.git` 是 `repo/.git` 的工作目录（`.git` 文件里写的是外面路径，读没问题；写要碰 `repo/.git/worktrees/…`，仍在 `repo` 里面），**理论上仍在其沙箱可写范围**，但没实测。请整合方定要不要在真机上再验这一条。

## 整合方复审（2026-10-23）

**结论：并入。** 逐行读了 diff（源码 70 行）：启动器只在没有 `IXAEON_WORKTREES` 时才设；替推的检查加的那一条先要 `.git` 在角色的 `cwd` 里、再比 `origin`（去掉末尾的 `/` 和 `.git`，Windows 上不分大小写），两个 `origin` 有一个拿不到就不放行；交代里那句照字面拼接；`relay init` 本地克隆再改 `origin`。测试是整合方写好锁定的，`run L6b` 8 条全过，L1–L6 回归全过。真机检查乙一次跑通（DSH 提交成、写出 `RELAY-PUSH`、调度器推上临时裸仓库），没要求「切完全权限」，DSH 真调用 1 次。

已实现：上面。自动化通过：上面。真机通过：乙（临时裸仓库，不连 GitHub）。用户接受：未发生——下一步整合方在用户看着的情况下跑第一棒真活。
