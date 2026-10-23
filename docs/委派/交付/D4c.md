# D4c 建分支失败时带上 git 的原话 交付

- 分支：`dev/D4c`，基于 main `233dbbc`；档位 **A**
- 执行方：dev

## 已实现

| 文件                                                   | 改动          | 什么                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/execution/landing.ts`               | +35 −6        | `gitText` 把 git 的错误输出**整段**挂到错误对象上（`err.stderr`，`message` 仍是首行，别处照旧）；`catch` 里新增 `firstGitLine(stderr, why)`，在 `建分支失败：<why>` 后面接上一句 git 的原话 |
| `packages/core/test/acceptance/d4c-git-stderr.test.ts` | 新，约 120 行 | 新测试：造一个一定让 `git worktree add` 失败的场景（`post-checkout` 钩子往 stderr 写一句固定的话再退出 1），断言回报原因里有 git 的原话、不是只剩「Command failed: git …」                  |

源码改动约 **35 行**（只算 `apps/*/src`、`packages/*/src`）。

**挑「哪一句」的规矩**（委派单只说「第一条非空行」，实测那样挑不到有用的，所以定成下面这样，请 Codex 与整合方看）：

1. 跳过空行、跳过和 `why`（错误信息首行）重复的那一行；
2. **优先**要 `error:` / `fatal:` 开头、或带 `hook` 的（git 真正说原因的那句）；
3. 再取第一条不是 `Preparing worktree …` 这类进度话的非空行；
4. 都不合适就**不接**（照旧只写 `why`，不硬塞废话）。

去首尾空白、最多 200 字。**实测**：钩子拒绝时 git 的 stderr 是

```
Preparing worktree (new branch 'ixaeon/xxxx')
D4C-合成的钩子拒绝
fatal: 钩子执行失败（exit 1）
```

而 `why`（`err.message` 首行）恰好就是 `Preparing worktree (new branch 'ixaeon/xxxx')`——所以「第一条非空行」挑出来的和 `why` 一样，白接。现在挑到的是 `D4C-合成的钩子拒绝`（钩子原话），输出变成：

```
建分支失败：Preparing worktree (new branch 'ixaeon/xxxx')：D4C-合成的钩子拒绝
```

**没有动** D4 的锁定测试（`d4-apply-branch.test.ts`、`d4-landing-report.test.ts`、`d4-tasks-page.test.ts` 的指纹没变）；新测试另起一个文件，自己搭最小 harness（照锁定测试的搭法），不 import 它。

## 自动化通过

- `node scripts/acceptance.mjs run D4`：**3 个文件、30 条全过**（20 条锁定的 + 5 条桌面回报 + 1 条我新加的 `d4c-git-stderr`）。
- `node scripts/verify.mjs`：**全过**（2026-10-23 11:3x，末行「全部通过（IXAEON v0.2 验证完成）」）。

## 真机通过

**本机复现那条偶发：没复现出来。**

1. 单独连跑那个测试（`真实 IPC 入口：点「接受」走的那条通道也触发落地回报`）**30 遍：全绿**（0 红）。
2. 按 `scripts/real/q2-flaky-repro.mjs` 的做法在**机器忙**时再跑：起 20 个占 CPU 的 node 进程（限时 2 分钟），同测试连跑 **12 遍：也全绿**。

也就是说，**在加了 git 原话之前之后、本机这台机器上，这条偶发都跑不出来**。CI 上两次红（Q2 那轮、2026-10-23 L5/L6 并入时）和本机环境不一样（CI 是干净的 runner，并发、磁盘、CPU、git 版本都不同），所以：

- **偶发原因：没查到**。试了：30 遍连跑、20 进程烤机下 12 遍，共 42 遍，0 红。
- 这一单**没有做任何治本改动**（没有改 landing 的建分支/提交流程、没有加锁或重试）——没有证据表明该改哪儿，乱改比不改更糟。
- **价值仍然成立**：以后 CI 再红，回报里会带上 git 的原话（比如 `index.lock` 被占、`fatal: cannot lock ref` 之类），**下一次就有据可查**。这是这一单真正买到的东西。

## Codex 审查

（跑完补。）

## 用户接受

未发生。

## 已知缺口

1. **偶发没复现、原因没查到**（如实写：42 遍 0 红）。要再查只能等 CI 下一次红、拿回报里新带出来的 git 原话。
2. `err.stderr` 是我在 `gitText` 里挂上去的非标准字段（`execFile` 的 `stderr` 参数）。别处若也想用，最好把它提成正式类型；这一单只在 `catch` 里用。
3. 「挑哪一句」的规矩是我定的（委派单只说第一条非空行），Codex 或整合方觉得该照字面取第一条，我改。
