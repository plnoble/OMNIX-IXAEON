# D4c 建分支失败时带上 git 的原话 交付

- 分支：`dev/D4c`，基于 main `233dbbc`；档位 **A**
- 执行方：dev

## 已实现

| 文件                                                   | 改动          | 什么                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/execution/landing.ts`               | +40 −6        | `gitText` 失败时把 git 的错误输出**整段**挂到错误对象上（`err.stderr`，`message` 保持 node 的原话 `Command failed: git …`）；`catch` 里新增 `firstGitLine(stderr)`，在 `建分支失败：<why>` 后面接上**错误输出里第一条非空的行**（去首尾空白，最多 200 字），没有错误输出就照旧 |
| `packages/core/test/acceptance/d4c-git-stderr.test.ts` | 新，约 200 行 | 新测试 4 条：建树失败（post-checkout 钩子）、提交被钩子拒绝（pre-commit）、超长原话截断 200 字、没有错误输出照旧                                                                                                                                                               |

源码改动约 **40 行**（只算 `apps/*/src`、`packages/*/src`）。没动 D4 的锁定测试（三个文件的指纹没变）。

**取行规则**（照委派单字面，Codex 第一轮纠正后恢复）：**错误输出里第一条非空的行**，去掉首尾空白，最多 200 字；没有错误输出就不追加。

**为什么必须改 `gitText` 的 message**（第一版我改错了）：原实现把 `err.message` 的首行取成 stderr 首行，于是 `why` 本身就是那句原话，「再接第一条非空行」只会重复。现在 `message` 保持 node 的原话（`Command failed: git commit -am msg`），stderr 整段另挂，两者才分得开，拼出来才有新信息：

```
建分支失败：Command failed: git commit -am msg：D4C_COMMIT_HOOK_SAYS
```

## 自动化通过

`node scripts/acceptance.mjs run D4` 原样（4 个测试文件：锁定的 2 个 + 我新加的 1 个 + 桌面任务页）：

```
 ✓ |acceptance| apps/desktop/test/acceptance/d4-tasks-page.test.ts (5 tests) 57ms
 ✓ |acceptance| apps/desktop/test/acceptance/d4-landing-report.test.ts (5 tests) 5375ms
 ✓ |acceptance| packages/core/test/acceptance/d4-apply-branch.test.ts (20 tests) 27347ms
 ✓ |acceptance| packages/core/test/acceptance/d4c-git-stderr.test.ts (4 tests) 6229ms
 Test Files  4 passed (4)
      Tests  34 passed (34)
```

（Codex 第一轮点出我上一版把数字写错：只列了 3 个文件 30 条，漏了新文件。已核正为 4 个文件 34 条。）

`node scripts/verify.mjs`：**全过**（2026-10-23 12:1x，末行「全部通过（IXAEON v0.2 验证完成）」）。

## 真机通过

**本机复现那条偶发：没复现出来（42 遍 0 红）。**

1. 单独连跑 `真实 IPC 入口：点「接受」走的那条通道也触发落地回报` 30 遍：

```
pass=30 fail=0
```

2. 机器忙时（照 `scripts/real/q2-flaky-repro.mjs` 的做法，起 20 个占 CPU 的 node 进程、限时 2 分钟）再跑 12 遍：

```
占 CPU 的进程 20 个，限时 2 分钟
busy: pass=12 fail=0
```

**本机 30 + 12 = 42 遍全绿，没有复现。** CI 上两次红（Q2 那轮、2026-10-23 L5/L6 并入时）和本机环境不同（runner 并发、磁盘、git 版本都不同），所以：

- **偶发原因：没查到**（试了 42 遍，0 红）。
- 这一单**没有做任何治本改动**（没改建分支/提交流程、没加锁、没加重试）——没有证据表明该改哪儿。
- 价值仍然成立：以后 CI 再红，回报里会带上 git 的原话（比如 `index.lock` 被占、`fatal: cannot lock ref`），**下一次就有据可查**。

## Codex 审查

第一轮（2026-10-23）结论「需要修改」，4 条必须改，逐条处理：

1. **「实现跳过与 `why` 相同的行、优先挑 `error:`/`fatal:`/`hook`，违反委派单明确要求的『第一条非空行』」** → 已恢复照字面取**第一条非空行**（去首尾空白、最多 200 字）；同时把 `err.message` 保持 node 原话，使 `why` 与那条原话不再重合（见上）。
2. **「宽泛匹配 `hook|exit code` 不能证明追加的是 stderr 第一条非空行；未覆盖截断与无 stderr」** → 测试改成 4 条分别断言：接上的就是 stderr 第一条非空行（钩子原话字面）、200 字截断（含「不多接第 201 字」）、无 stderr 时不追加冒号、D4 条件 8 收尾。
3. **「文档描述与实现矛盾」** → 已按实际行为重写（含「`why` 与第一条非空行重合」这个实测现象和 `gitText` 的修法）。
4. **「验收计数 20+5+1=26 与『30 条』矛盾，且只有摘要没有原样输出」** → 已贴 vitest 原样输出并核正为 **4 个文件 34 条**。

第二轮：待跑。

## 用户接受

未发生。

## 已知缺口

1. **偶发没复现、原因没查到**（如实写：42 遍 0 红）。要再查只能等 CI 下一次红、拿回报里新带出来的 git 原话。
2. `err.stderr` 是我在 `gitText` 里挂上去的非标准字段（`execFile` 的 `stderr` 参数）。别处若也想用，最好提成正式类型；这一单只在 `catch` 里用。
3. 当 git 的 stderr 第一条非空行恰好就是 `why`（例如 `post-checkout` 钩子拒绝时 git 自己打的 `Preparing worktree …`，虽然改了 `message` 之后 `why` 是 `Command failed: git …`，但某些平台上 node 的 message 可能不含 stderr）时，照字面会拼成重复的一句。委派单没说要跳过，Codex 也要求照字面，所以**保留照字面**，这里如实记下，请整合方定要不要加「相同就不接」。
